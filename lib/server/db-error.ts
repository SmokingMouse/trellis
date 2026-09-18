import "server-only";

// SQLite 写失败的分类 + 文案 + 重试闸（S176，BOE 2026-09-18 13:39 现场）。
//
// 事故形状：/data00 用到 94%，SQLite 连抛三次 `SQLITE_FULL: database or disk is
// full`（瞬时，事后自愈）。而整条写路径上的 `catch {}` 把它们全吞了 —— 用户看到
// 的是「提问转圈、永远不回」，服务端一行日志都没有。
//
// 三条设计判断：
//  · **分类先于重试**：SQLITE_BUSY / LOCKED 是「别人正握着写锁」，退一步再来就好；
//    SQLITE_FULL / IOERR / READONLY 重试一百次也是同一个结果，只会把用户多晾几秒。
//    所以只有前者进退避，后者立刻报。
//  · **抛 DbWriteError 而不是原样上抛**：调用方（run-bus / route）需要一个稳定的
//    判据来区分「DB 写不进去」和「模型自己报错」，字符串匹配那种判据迟早会错。
//  · **文案带可操作提示**：一个 stack 对用户等于没说。`userMessage` 是给人看的那句。

export type SqliteFailureKind =
  | "full" // 磁盘满
  | "io" // 磁盘 / 文件系统 I/O 错误
  | "busy" // 写锁被占（瞬时，可重试）
  | "readonly" // 只读挂载 / 权限
  | "corrupt" // 文件损坏
  | "unknown";

/** 瞬时、值得退避重试的类别。其余一律立刻报错。 */
export function isTransientKind(kind: SqliteFailureKind): boolean {
  return kind === "busy";
}

const CODE_IN_MESSAGE = /SQLITE_[A-Z0-9_]+/;

/** 取 SQLite 错误码。bun:sqlite 的 SQLiteError 带 `.code`；拿不到就从 message 里捞
 * （SDK / 驱动换实现时这层不至于整个瞎掉）。 */
export function sqliteErrorCode(err: unknown): string | null {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_")) return code;
  }
  const m = CODE_IN_MESSAGE.exec(errText(err));
  return m ? m[0] : null;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function classifyDbError(err: unknown): SqliteFailureKind {
  const code = sqliteErrorCode(err) ?? "";
  const msg = errText(err).toLowerCase();
  if (code.startsWith("SQLITE_FULL") || msg.includes("disk is full")) {
    return "full";
  }
  if (code.startsWith("SQLITE_IOERR") || msg.includes("disk i/o error")) {
    return "io";
  }
  if (
    code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    msg.includes("database is locked") ||
    msg.includes("database table is locked")
  ) {
    return "busy";
  }
  if (code.startsWith("SQLITE_READONLY") || msg.includes("readonly database")) {
    return "readonly";
  }
  if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) {
    return "corrupt";
  }
  return "unknown";
}

/** 这个 err 是不是一次 SQLite 写失败（而不是业务异常）。 */
export function isDbFailure(err: unknown): boolean {
  if (err instanceof DbWriteError) return true;
  if (sqliteErrorCode(err)) return true;
  return classifyDbError(err) !== "unknown";
}

function userMessageFor(
  kind: SqliteFailureKind,
  code: string | null,
  raw: string,
  attempts: number,
): string {
  const tag = code ? `（${code}）` : "";
  switch (kind) {
    case "full":
      return `数据库写入失败：磁盘空间不足${tag}。这一轮的内容没能存下来。请先清理 ~/.trellis/data.db 所在分区（或把 TRELLIS_DB_PATH 指到更大的盘），再重试提问。`;
    case "io":
      return `数据库写入失败：磁盘 I/O 错误${tag}。磁盘或文件系统可能出了问题，请检查磁盘健康与挂载状态后重试。`;
    case "busy":
      return `数据库写入失败：数据库长时间被占用${tag}，已重试 ${attempts} 次仍未成功。通常是另一个进程正握着写锁，稍后重试即可。`;
    case "readonly":
      return `数据库写入失败：数据库当前不可写${tag}。请检查 ~/.trellis/data.db 的文件权限与磁盘是否被只读挂载。`;
    case "corrupt":
      return `数据库写入失败：数据库文件可能已损坏${tag}。请停服并从备份恢复，不要继续写入。`;
    default:
      return `数据库写入失败：${raw}`;
  }
}

export class DbWriteError extends Error {
  readonly kind: SqliteFailureKind;
  readonly code: string | null;
  /** 给人看的那句（前端直接显示这个，不显示 stack）。 */
  readonly userMessage: string;
  /** 实际尝试次数（含第一次）。 */
  readonly attempts: number;
  readonly label: string;

  constructor(label: string, cause: unknown, attempts: number) {
    const kind = classifyDbError(cause);
    const code = sqliteErrorCode(cause);
    const raw = errText(cause);
    const userMessage = userMessageFor(kind, code, raw, attempts);
    super(userMessage);
    this.name = "DbWriteError";
    this.kind = kind;
    this.code = code;
    this.userMessage = userMessage;
    this.attempts = attempts;
    this.label = label;
    this.cause = cause;
  }
}

/** 默认尝试次数（含第一次）与退避表。 */
export const DB_RETRY_ATTEMPTS = 4;
const BACKOFF_MS = [20, 60, 180];

/**
 * 一次写的**总等待预算**（毫秒）。fix-d1 返工新增。
 *
 * 之前这层只有「最多重试 4 次、退避加起来约 0.26s」这个说法 —— 不成立：退避表只
 * 管应用层自己睡了多久，**没算 SQLite 自己等锁的时间**。sqlite.ts 开着
 * `PRAGMA busy_timeout`，每一次 attempt 在真实写锁下都会先同步阻塞到超时才抛
 * BUSY；异源复核用第二个连接 `BEGIN IMMEDIATE` 持锁实测：一次 append 阻塞
 * **42033ms**，而且是同步阻塞（期间连 1ms 的 timer 都跑不了，事件循环整个停摆）。
 *
 * 所以改成「数据库等待 + 应用重试」共用一个总预算：
 *   · busy_timeout 由 sqlite.ts 设成同一个预算值 —— 单次 SQLite 等锁不会超过它；
 *   · dbWrite 每次要退避前先看预算还剩多少，剩余 ≤0 就当场按失败返回，不再发起
 *     新的 attempt，退避本身也被剩余量截断。
 * 于是一次写卡在锁上的总时长收敛到 ≈ 预算（最坏情况下多一次尚未超时的 attempt），
 * 而不是「4 × busy_timeout + 退避」那样无界叠加。
 *
 * 默认 2s：比一次提问的感知延迟略长、比事件循环停摆几十秒可接受得多；写密集的
 * 部署可以用 TRELLIS_DB_WAIT_BUDGET_MS 调大（0 = 不设预算，退回纯次数上限）。
 */
export const DEFAULT_DB_WAIT_BUDGET_MS = 2000;

export function dbWaitBudgetMs(): number {
  const raw = process.env.TRELLIS_DB_WAIT_BUDGET_MS;
  if (raw === undefined || !raw.trim()) return DEFAULT_DB_WAIT_BUDGET_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DB_WAIT_BUDGET_MS;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
    Bun.sleepSync(ms);
    return;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* bun:sqlite 是同步 API，这里只能同步等 */
  }
}

// 测试注入闸：让「磁盘满」这种没法在单测里真的制造出来的故障可被复现。
// 与 resetDBForTests 同一性质 —— 只给测试用，生产路径 fault 永远是 null。
let fault: { code: string; message: string; remaining: number } | null = null;

export function setDbFaultForTests(
  spec: { code: string; message?: string; times?: number } | null,
): void {
  fault = spec
    ? {
        code: spec.code,
        message: spec.message ?? `${spec.code}: injected fault`,
        remaining: spec.times ?? Number.POSITIVE_INFINITY,
      }
    : null;
}

function takeFault(): Error | null {
  if (!fault || fault.remaining <= 0) return null;
  fault.remaining -= 1;
  const e = new Error(fault.message) as Error & { code: string };
  e.code = fault.code;
  return e;
}

/**
 * 包住一次 DB 写。瞬时错误（BUSY/LOCKED）短退避重试，其余立刻抛 DbWriteError。
 * 重试受**总等待预算**约束（见 DEFAULT_DB_WAIT_BUDGET_MS）：预算耗尽即按失败返回。
 *
 * 注意**不要**把读也包进来：读失败不该拖慢路径，也不该被当成「这轮没存下」。
 */
export function dbWrite<T>(
  label: string,
  fn: () => T,
  opts?: {
    attempts?: number;
    sleep?: (ms: number) => void;
    /** 总等待预算覆盖（毫秒，0 = 不设预算）。缺省走 dbWaitBudgetMs()/env。 */
    budgetMs?: number;
    /** 计时钟（测试用）。 */
    now?: () => number;
  },
): T {
  const attempts = Math.max(1, opts?.attempts ?? DB_RETRY_ATTEMPTS);
  const sleep = opts?.sleep ?? sleepSync;
  const now = opts?.now ?? Date.now;
  const budget = opts?.budgetMs ?? dbWaitBudgetMs();
  const startedAt = now();
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const injected = takeFault();
      if (injected) throw injected;
      return fn();
    } catch (err) {
      if (err instanceof DbWriteError) throw err; // 嵌套 dbWrite：别重复包
      last = err;
      const kind = classifyDbError(err);
      if (!isTransientKind(kind) || i === attempts - 1) {
        throw new DbWriteError(label, err, i + 1);
      }
      // 预算闸：这次 attempt 已经把预算烧光（典型形状是 SQLite 自己等锁等满
      // busy_timeout），就别再起新的一轮 —— 用户宁可现在看到明确报错。
      const remaining = budget > 0 ? budget - (now() - startedAt) : Infinity;
      if (remaining <= 0) {
        throw new DbWriteError(label, err, i + 1);
      }
      sleep(Math.min(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)], remaining));
    }
  }
  // 不可达（循环要么 return 要么 throw），留给类型收敛。
  throw new DbWriteError(label, last, attempts);
}
