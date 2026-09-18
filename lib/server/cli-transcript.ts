// CLI transcript 解析的**唯一入口**：provider 分派 + stat 短路 + 尾部增量 +
// 协作式分片（不阻塞事件循环）。
//
// 为什么在这一层做：devbox 上一个存活的 codex rollout 已经 185MB，且被持续写入
// （约 10s +60KB）。老实现每次 fs.watch 去抖后都 readFileSync 整个文件、
// JSON.parse 每一行、再跑一遍全量 reduce —— 阵发性 100% CPU，尖峰时 /login 要
// 1–3.3s。三条治理各自解决一段：
//
//   1. 短路：先 stat。(dev, ino, size, mtimeMs) 与上次完全一致 → 直接返回缓存
//      结果，**一个字节都不读**。持续写入的文件之外，绝大多数 lineage 每次
//      reimport 都走这条。
//   2. 增量：只读 [上次偏移, 当前 size) 这一段，把新增的完整行 JSON.parse 后
//      追加到缓存的 entry 数组上。前缀既不重读也不重 parse。
//   3. 分片：把 entry 数组 → ParsedCliSession 的 reduce 写成 generator
//      （./cli-import 的 reduceCliEntries / ./codex-import 的 reduceCodexEntries），
//      异步入口用 runCooperatively 驱动，片间 setImmediate 让出事件循环。
//
// 为什么不用 worker_thread（README 里也记了）：ParsedCliSession 本身就是个大
// 对象（185MB rollout 上是几万个 turn + toolCalls），postMessage 的 structured
// clone 在主线程上同样是一次 O(n) 的同步阻塞 —— 那只是把阻塞从「解析」挪到
// 「序列化」。而且增量缓存必须常驻主进程（watcher 在主进程），跨线程维护同一份
// 缓存要么双份内存、要么每次传整个 entry 数组。分片让出没有这些代价。
//
// 等价性契约：全量一次解析 与 分多次增量解析，必须得到**完全相同**的
// ParsedCliSession。保证方式是「增量只发生在按行切分这一层」——
// reduce 拿到的 entry 数组与全量读一模一样（见下面 residue 的处理），而 reduce
// 是纯函数。回归见 lib/server/cli-transcript-incremental.test.ts。
import fs from "node:fs";
import path from "node:path";
import type { ParsedCliSession } from "./cli-import";
import { reduceCliEntries } from "./cli-import";
import { reduceCodexEntries } from "./codex-import";
import type { CliRawEntry } from "./cli-jsonl";
import {
  DEFAULT_SLICE_MS,
  makeSlicer,
  runCooperatively,
  runToCompletion,
} from "./cooperative";

export type CliProvider = "claude" | "codex";

// 一次 read syscall 的上限。异步路径按它分片，片间让出事件循环。
const CHUNK_BYTES = 1024 * 1024;
// 缓存上限：条目数 + 保留字节数。cli-discover 的候选扫描会把几百个 jsonl 过一遍，
// 不设上限等于把整个 ~/.claude/projects 常驻内存。
const MAX_CACHED_FILES = 32;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;

type CacheEntry = {
  provider: CliProvider;
  dev: number;
  ino: number;
  /** 已消费到的字节偏移（== 上次 stat 的 size）。 */
  offset: number;
  mtimeMs: number;
  /** 末尾那截还没等到换行的字节。按 Buffer 存，避免在多字节字符中间切断。 */
  residue: Buffer;
  /** 已提交的完整行解析结果（残片永不进这里）。 */
  committed: unknown[];
  result: ParsedCliSession | null;
  /** 每次读取自增；异步 reduce 回写结果前比对，防止用旧快照覆盖新结果。 */
  version: number;
  /**
   * 异步分片摄入进行中。分片摄入横跨多个事件循环 tick，期间 committed/residue
   * 处于半截状态 —— 这时候来的同步调用必须绕开缓存自己全量读一遍，绝不能往
   * 同一个 entry 上追加（两个写者交错追加会把行序搅乱）。
   */
  busy: boolean;
};

export type CliTranscriptCacheStats = {
  /** stat 命中、零文件读取的次数。 */
  shortCircuits: number;
  /** 只读尾部增量的次数。 */
  incrementalReads: number;
  /** 整文件重读的次数（首次 / 截断 / 重写 / inode 变）。 */
  fullReads: number;
  bytesRead: number;
  /** 因截断、重写、inode 变化或文件消失而丢弃缓存的次数。 */
  evictions: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ParsedCliSession | null>>();
const stats: CliTranscriptCacheStats = {
  shortCircuits: 0,
  incrementalReads: 0,
  fullReads: 0,
  bytesRead: 0,
  evictions: 0,
};

export function cliTranscriptCacheStats(): CliTranscriptCacheStats {
  return { ...stats };
}

/** 测试用：清空缓存与计数。生产代码不该调用。 */
export function resetCliTranscriptCache(): void {
  cache.clear();
  inflight.clear();
  stats.shortCircuits = 0;
  stats.incrementalReads = 0;
  stats.fullReads = 0;
  stats.bytesRead = 0;
  stats.evictions = 0;
}

function cacheKey(provider: CliProvider, jsonlPath: string): string {
  return `${provider}:${jsonlPath}`;
}

function touch(key: string, entry: CacheEntry): void {
  // Map 保插入序 —— 删了再插即把它挪到队尾，队头就是 LRU。
  cache.delete(key);
  cache.set(key, entry);
  let bytes = 0;
  for (const e of cache.values()) bytes += e.offset;
  while (
    cache.size > MAX_CACHED_FILES ||
    (bytes > MAX_CACHED_BYTES && cache.size > 1)
  ) {
    const oldest = cache.keys().next();
    if (oldest.done || oldest.value === key) break;
    bytes -= cache.get(oldest.value)?.offset ?? 0;
    cache.delete(oldest.value);
  }
}

function statOrNull(jsonlPath: string): fs.Stats | null {
  try {
    return fs.statSync(jsonlPath);
  } catch {
    return null;
  }
}

/**
 * 把新读到的字节并进「完整行 + 残片」。
 * 残片按 Buffer 留存：切在多字节字符中间时，下次拼上后续字节才解码，不会出现
 * 全量解析不会有的替换字符。
 */
function splitLines(
  incoming: Buffer,
  residue: Buffer,
): { lines: string[]; residue: Buffer } {
  const buf = residue.length > 0 ? Buffer.concat([residue, incoming]) : incoming;
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return { lines: [], residue: buf };
  const text = buf.toString("utf8", 0, lastNewline + 1);
  return {
    // 末尾那个 "\n" 切出来的空串由下面的 trim 闸挡掉。
    lines: text.split("\n"),
    residue: buf.subarray(lastNewline + 1),
  };
}

function pushParsedLines(lines: string[], into: unknown[]): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      into.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 —— 与全量解析一致 */
    }
  }
}

/**
 * 残片的「试探解析」。
 *
 * 这是等价性的关键一环。全量解析里，文件末尾没有换行的那一行**照样会被
 * JSON.parse**：写完整了就是一条 entry，写了一半就抛异常被跳过。增量这边残片
 * 是不提交的（它随时可能被后续字节续写），所以每次 reduce 前按同样规则临时
 * 试一次：解得出就当成最后一条 entry 参与本次 reduce，解不出就当它不存在。
 * 两种情况都与全量解析逐字相同，而残片本身仍留在缓存里等下次续写。
 */
function tentativeEntry(residue: Buffer): unknown | undefined {
  if (residue.length === 0) return undefined;
  const text = residue.toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function snapshotEntries(entry: CacheEntry): unknown[] {
  const tentative = tentativeEntry(entry.residue);
  // 永远拷一份：异步 reduce 横跨多个事件循环 tick，期间可能有别的调用往
  // committed 上追加。reduce 必须跑在一个不会被改动的快照上。
  const out = entry.committed.slice();
  if (tentative !== undefined) out.push(tentative);
  return out;
}

function makeReducer(
  provider: CliProvider,
  entries: unknown[],
  jsonlPath: string,
  byteLength: number,
): Generator<void, ParsedCliSession | null> {
  return provider === "codex"
    ? reduceCodexEntries(
        entries as Parameters<typeof reduceCodexEntries>[0],
        jsonlPath,
        byteLength,
      )
    : reduceCliEntries(entries as CliRawEntry[], jsonlPath);
}

type Plan =
  | { kind: "cached"; entry: CacheEntry }
  | { kind: "append"; entry: CacheEntry; from: number; to: number }
  | { kind: "full"; to: number };

/**
 * 决定这次要怎么读。所有「缓存不可信」的分支都退回全量：
 *   - 没有缓存 / provider 不同           → 首次
 *   - dev/ino 变了                      → 文件被删后重建（或被 rename 覆盖）
 *   - size 比已消费偏移小                → 被截断
 *   - size 相同但 mtime 变了             → 原地重写（长度恰好没变）
 * 只有 inode 相同且 size 单调增长时才敢认「前缀没动过」。
 */
function planRead(
  key: string,
  provider: CliProvider,
  st: fs.Stats,
): Plan {
  const entry = cache.get(key);
  if (!entry || entry.provider !== provider) return { kind: "full", to: st.size };
  if (entry.dev !== st.dev || entry.ino !== st.ino) {
    stats.evictions++;
    cache.delete(key);
    return { kind: "full", to: st.size };
  }
  if (st.size < entry.offset) {
    stats.evictions++;
    cache.delete(key);
    return { kind: "full", to: st.size };
  }
  if (st.size === entry.offset) {
    if (st.mtimeMs === entry.mtimeMs) return { kind: "cached", entry };
    stats.evictions++;
    cache.delete(key);
    return { kind: "full", to: st.size };
  }
  return { kind: "append", entry, from: entry.offset, to: st.size };
}

function freshEntry(provider: CliProvider, st: fs.Stats): CacheEntry {
  return {
    provider,
    dev: st.dev,
    ino: st.ino,
    offset: 0,
    mtimeMs: st.mtimeMs,
    residue: Buffer.alloc(0),
    committed: [],
    result: null,
    version: 0,
    busy: false,
  };
}

/** 读到的身份/偏移落到缓存条目上（字节内容由调用方先摄入）。 */
function finalizeRead(entry: CacheEntry, st: fs.Stats, to: number): void {
  entry.offset = to;
  entry.mtimeMs = st.mtimeMs;
  entry.dev = st.dev;
  entry.ino = st.ino;
  entry.version++;
}

// ── 同步入口（老调用方语义不变，只是多了短路与增量）─────────────────────────

function readRangeSync(
  jsonlPath: string,
  from: number,
  to: number,
): Buffer | null {
  const length = to - from;
  if (length <= 0) return Buffer.alloc(0);
  let fd: number;
  try {
    fd = fs.openSync(jsonlPath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return read === length ? buf : buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Keep sync/import callers provider-agnostic without changing Claude parsing. */
export function parseCliTranscript(
  provider: CliProvider,
  jsonlPath: string,
): ParsedCliSession | null {
  const key = cacheKey(provider, jsonlPath);
  const st = statOrNull(jsonlPath);
  if (!st || !st.isFile()) {
    // 文件没了 → 缓存必须一并作废。cli-import-db 的 anyUnreadable 闸靠
    // 「parse 返回空 + 文件不存在」判「我们对这条 lineage 一无所知」，
    // 这时候再吐一份旧快照会让它误判成「读到了但没内容」，清理逻辑就会
    // 拿残缺集合去删节点。
    if (cache.delete(key)) stats.evictions++;
    return null;
  }

  // 有异步分片摄入正在半路上 → 这次同步调用绕开缓存，自己全量读一遍。
  // 往同一个 entry 上并发追加会把行序搅乱，宁可多花一次全量。
  const bypassCache = (): ParsedCliSession | null => {
    stats.fullReads++;
    const whole = readRangeSync(jsonlPath, 0, st.size);
    if (whole === null) return null;
    stats.bytesRead += whole.length;
    const scratch: unknown[] = [];
    const split = splitLines(whole, Buffer.alloc(0));
    pushParsedLines(split.lines, scratch);
    const tentative = tentativeEntry(split.residue);
    if (tentative !== undefined) scratch.push(tentative);
    return runToCompletion(
      makeReducer(provider, scratch, jsonlPath, whole.length),
    );
  };

  const plan = planRead(key, provider, st);
  if (plan.kind === "cached") {
    if (plan.entry.busy) return bypassCache();
    stats.shortCircuits++;
    touch(key, plan.entry);
    return plan.entry.result;
  }
  if (plan.kind === "append" && plan.entry.busy) return bypassCache();

  const entry = plan.kind === "append" ? plan.entry : freshEntry(provider, st);
  const from = plan.kind === "append" ? plan.from : 0;
  const incoming = readRangeSync(jsonlPath, from, plan.to);
  if (incoming === null) {
    // stat 得到、读不到（权限等）。不缓存，语义与老实现一致：返回 null。
    if (cache.delete(key)) stats.evictions++;
    return null;
  }
  if (plan.kind === "append") stats.incrementalReads++;
  else stats.fullReads++;
  const split = splitLines(incoming, entry.residue);
  pushParsedLines(split.lines, entry.committed);
  entry.residue = split.residue;
  stats.bytesRead += incoming.length;
  finalizeRead(entry, st, from + incoming.length);

  const version = entry.version;
  const result = runToCompletion(
    makeReducer(provider, snapshotEntries(entry), jsonlPath, entry.offset),
  );
  if (entry.version === version) entry.result = result;
  touch(key, entry);
  return result;
}

// ── 异步入口（watcher 走这条：分片读 + 分片 reduce，片间让出事件循环）────────

/**
 * 分片摄入 [from, to)：每读一片就地切行 + JSON.parse，片间让出事件循环。
 *
 * 关键在于**不能**先把整段读成一个 Buffer 再一次性 decode+split+parse ——
 * 那一步本身就是 60MB ≈ 100ms 的同步阻塞（实测），等于白分片。按 4MB 一片
 * 处理，单片的 decode+split+parse 约 7ms，整个冷启动解析期间事件循环最长
 * 只被占用一个时间片。
 *
 * 成功返回实际摄入的字节数；读失败返回 null（调用方作废缓存）。
 */
async function ingestRangeAsync(
  entry: CacheEntry,
  jsonlPath: string,
  from: number,
  to: number,
  sliceMs: number,
): Promise<number | null> {
  const length = to - from;
  if (length <= 0) return 0;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(jsonlPath, "r");
  } catch {
    return null;
  }
  const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, length));
  let read = 0;
  let sliceStart = performance.now();
  try {
    while (read < length) {
      const want = Math.min(buf.length, length - read);
      const { bytesRead } = await handle.read(buf, 0, want, from + read);
      if (bytesRead <= 0) break;
      const split = splitLines(buf.subarray(0, bytesRead), entry.residue);
      pushParsedLines(split.lines, entry.committed);
      // subarray 是视图 —— 下一轮 read 会覆盖同一块内存，残片必须拷出来。
      entry.residue = Buffer.from(split.residue);
      read += bytesRead;
      stats.bytesRead += bytesRead;
      if (performance.now() - sliceStart >= sliceMs) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sliceStart = performance.now();
      }
    }
    return read;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * 与 parseCliTranscript 结果等价，但整个过程（读 + reduce）都分片让出事件循环。
 * watcher / 后台 import 走这条；同步调用方保持原样。
 */
export function parseCliTranscriptAsync(
  provider: CliProvider,
  jsonlPath: string,
  sliceMs: number = DEFAULT_SLICE_MS,
): Promise<ParsedCliSession | null> {
  const key = cacheKey(provider, jsonlPath);
  // 同一文件的并发异步解析合流 —— 否则两次全量 reduce 交错跑，CPU 翻倍且
  // 结果回写互相覆盖。
  const running = inflight.get(key);
  if (running) return running;
  const task = parseCliTranscriptAsyncInner(key, provider, jsonlPath, sliceMs)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

async function parseCliTranscriptAsyncInner(
  key: string,
  provider: CliProvider,
  jsonlPath: string,
  sliceMs: number,
): Promise<ParsedCliSession | null> {
  const st = statOrNull(jsonlPath);
  if (!st || !st.isFile()) {
    if (cache.delete(key)) stats.evictions++;
    return null;
  }

  const plan = planRead(key, provider, st);
  if (plan.kind === "cached") {
    stats.shortCircuits++;
    touch(key, plan.entry);
    return plan.entry.result;
  }

  const entry = plan.kind === "append" ? plan.entry : freshEntry(provider, st);
  const from = plan.kind === "append" ? plan.from : 0;
  if (plan.kind === "append") stats.incrementalReads++;
  else stats.fullReads++;
  entry.busy = true;
  let ingested: number | null;
  try {
    ingested = await ingestRangeAsync(entry, jsonlPath, from, plan.to, sliceMs);
  } finally {
    entry.busy = false;
  }
  if (ingested === null) {
    if (cache.delete(key)) stats.evictions++;
    return null;
  }
  finalizeRead(entry, st, from + ingested);

  const version = entry.version;
  const snapshot = snapshotEntries(entry);
  const result = await runCooperatively(
    makeReducer(provider, snapshot, jsonlPath, entry.offset),
    sliceMs,
  );
  if (entry.version === version) entry.result = result;
  // 期间可能有同步调用判定文件被截断/重写而把这个 key 换成了新条目 ——
  // 那份更新，别用我们手上这份旧的盖回去。
  const current = cache.get(key);
  if (current === undefined || current === entry) touch(key, entry);
  return result;
}

// ── transcript 三态 ─────────────────────────────────────────────────────────
//
// 一个 transcript 只有三种结局，**「读到了但没内容」和「读不到」必须分开**：
//   ready      有可解析轮次
//   empty      读到了，但没有轮次 —— 合法的零轮次会话（只有 mode /
//              file-history-snapshot / slash-command 噪声行）。确定性结果，
//              重试一万次也一样。
//   unreadable 打不开（ENOENT / EACCES / EIO / EISDIR …）或有坏行（CLI 可能
//              正写到一半）。这意味着我们对这条 transcript 的 turn 集合
//              **一无所知**，是**临时**状态，值得下一轮再试。
//
// 关键：**不能拿 parseCliTranscript 返回 null 当「读不到」的判据** —— 合法空会话
// 同样返回 null（cli-import.ts:131 与 :328），两者只能靠文件本身分开。
// 这条判据的另一面在 cli-import-db.ts:parseLineagesChecked：拿残缺的 turn 集合去做
// 「不在集合里就删」的清理，会把整条 lineage 的节点剥掉。

export type CliTranscriptState =
  | { kind: "ready"; parsed: ParsedCliSession }
  | { kind: "empty"; sessionId: string }
  | { kind: "unreadable" };

/** 「格式合法」= 打得开，且每一非空行都是合法 JSON。全部看文件结构，不看 error
 * message 字符串 —— 驱动换实现时字符串判据迟早会错。 */
export function readsAsJsonLines(file: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false; // ENOENT / EACCES / EIO / EISDIR 一视同仁：读不到
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * readsAsJsonLines 的分片版：逐片读、逐行试解析，片间让出事件循环。
 *
 * 为什么需要它：同步版是 `readFileSync(file, "utf8")` —— 对一个 197MB 的
 * rollout 就是一次几十秒的同步阻塞外加同样大小的字符串分配。而它正好落在
 * **attach 的必经之路**上（classify 每次都调，parse 出不来 turn 就进这一支），
 * 首次 attach 异步化之后它会是链上唯一剩下的巨型同步读。
 *
 * 判据与同步版逐字相同：打不开 → false；任何非空行不是合法 JSON → false；
 * 末尾没有换行的那一截照样当一行判。唯一的差别是同步版会被
 * 「文件大于最大字符串长度」直接 throw 成 false（= unreadable = 值得重试），
 * 这边读得完就照常定性 —— 那正是我们要的：巨大但合法的零轮次文件是**确定性**的
 * empty，不该被当成临时故障无限重试。
 */
export async function readsAsJsonLinesAsync(
  file: string,
  sliceMs: number = DEFAULT_SLICE_MS,
): Promise<boolean> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return false; // ENOENT / EACCES / EISDIR …：读不到
  }
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let residue = Buffer.alloc(0);
  const yieldSlice = makeSlicer(sliceMs);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      const split = splitLines(buf.subarray(0, bytesRead), residue);
      for (const line of split.lines) {
        if (!line.trim()) continue;
        try {
          JSON.parse(line);
        } catch {
          return false;
        }
      }
      // subarray 是视图，下一轮 read 会覆盖同一块内存 —— 残片必须拷出来。
      residue = Buffer.from(split.residue);
      await yieldSlice();
    }
  } catch {
    return false; // EIO / EISDIR：与同步版一视同仁
  } finally {
    await handle.close().catch(() => {});
  }
  const tail = residue.toString("utf8");
  if (tail.trim()) {
    try {
      JSON.parse(tail);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 分类一次**已经拿到**的解析结果。拆成这个形状是为了让异步解析路径
 * （watcher / 启动补齐的分片解析）能复用同一套判据而不必重新解析一遍。
 */
export function classifyParsedTranscript(
  file: string,
  parsed: ParsedCliSession | null,
): CliTranscriptState {
  if (parsed && parsed.turns.length > 0) return { kind: "ready", parsed };
  if (!readsAsJsonLines(file)) return { kind: "unreadable" };
  return {
    kind: "empty",
    sessionId: parsed?.sessionId ?? path.basename(file).replace(/\.jsonl$/, ""),
  };
}

/** 解析 + 分类的一步到位版本（同步路径用）。 */
export function classifyCliTranscript(
  provider: CliProvider,
  file: string,
): CliTranscriptState {
  return classifyParsedTranscript(file, parseCliTranscript(provider, file));
}

/**
 * classifyParsedTranscript 的分片版。三态判据**同一套**，只是把
 * 「定性时要重读一遍文件」那一步换成分片读（见 readsAsJsonLinesAsync）。
 */
export async function classifyParsedTranscriptAsync(
  file: string,
  parsed: ParsedCliSession | null,
  sliceMs: number = DEFAULT_SLICE_MS,
): Promise<CliTranscriptState> {
  if (parsed && parsed.turns.length > 0) return { kind: "ready", parsed };
  if (!(await readsAsJsonLinesAsync(file, sliceMs))) return { kind: "unreadable" };
  return {
    kind: "empty",
    sessionId: parsed?.sessionId ?? path.basename(file).replace(/\.jsonl$/, ""),
  };
}

/** 解析 + 分类的一步到位版本（异步路径用：attach / watcher / 启动补齐）。 */
export async function classifyCliTranscriptAsync(
  provider: CliProvider,
  file: string,
  sliceMs: number = DEFAULT_SLICE_MS,
): Promise<CliTranscriptState> {
  return classifyParsedTranscriptAsync(
    file,
    await parseCliTranscriptAsync(provider, file, sliceMs),
    sliceMs,
  );
}
