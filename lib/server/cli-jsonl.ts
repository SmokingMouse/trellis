// CLI session jsonl 的**共享**读取与 turn 归属原语（纯函数，无 DB / 无 server-only）。
//
// 存在的理由是一次真实的漂移事故：cli-import.ts（把 jsonl 解析成节点树）和
// cli-fork.ts（在某个 turn 上截前缀 jsonl 造分叉）各自抄了一份 turn-start 判据，
// 之后 import 那份在实测修 bug 时长出了 5 道结构闸（isMeta / promptSource /
// interruptedMessageId / isCompactSummary / isVisibleInTranscriptOnly），fork 那份
// 一道没跟。两边对「一个 turn 从哪开始」的答案就此分家，而 fork 的入参 turnUuid
// **正是 import 定的节点 id** —— 判据不同 = fork 在一条自己认不出的 turn 上截前缀。
//
// 2026-08-01 实测（889 个 jsonl / 1897 个有回答的 turn）：老判据下 36 个 turn
// （1.90%）根本找不到 tail（分叉静默降级成线性），另有 315 个（16.61%）选出的 tail
// 与 import 的归属不是同一条 —— 前缀被截在一个**没说完的回答**中间。
//
// 所以这两侧必须走同一份实现。执行者是编译器（两边都从这里 import），不是注释；
// 一致性由 scripts/test-cli-jsonl.ts 在真 jsonl 上回归。
import fs from "node:fs";

// ── jsonl entry 形状（只声明用到的字段，其余忽略）────────────────────────────

export type CliContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export type CliUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type CliRawEntry = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  // CLI 注入标记（skill 引导语 / Stop hook 通知 / "Continue from where you
  // left off." 等）。真用户输入从不带它 —— 见 isTurnStart。
  isMeta?: boolean;
  // 这条 user 消息从哪来："typed"(键入) / "sdk" / "queued" 都是真用户；
  // "system" 是 CLI 自己投递的（task-notification）。
  promptSource?: string;
  // 用户按 Esc 打断时 CLI 补的占位消息（"[Request interrupted by user]"）。
  // 它指向被打断的那条 assistant 消息，不带 isMeta / promptSource。
  interruptedMessageId?: string;
  // /compact 之后 CLI 注入的历史摘要（"This session is being continued from…"）。
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  aiTitle?: string;
  toolUseResult?: { stderr?: string; stdout?: string } | unknown;
  message?: {
    role?: string;
    content?: string | CliContentBlock[];
    usage?: CliUsage;
  };
};

// 带原始行号的 entry —— 截前缀时要按文件顺序切，行号不能丢。
export type CliRawLine = {
  lineIndex: number;
  entry: CliRawEntry;
};

// ── 基础谓词 ────────────────────────────────────────────────────────────────

export function ms(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

export function userText(e: CliRawEntry): string | null {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const texts = c
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length) return texts.join("\n");
  }
  return null;
}

export function isToolResultEntry(e: CliRawEntry): boolean {
  const c = e.message?.content;
  return Array.isArray(c) && c.some((b) => b.type === "tool_result");
}

// CLI 注入的命令/系统行不是真用户提问 —— 过滤掉。
export function isCommandNoise(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<bash-input>") ||
    t.startsWith("<bash-stdout>") ||
    t.startsWith("Caveat:")
  );
}

// 一个 turn 由「真·用户提问」开启。判定的难点全在于：CLI 会往对话流里塞一堆
// 长得和用户提问一模一样的 user 文本消息（skill 触发时的 "Base directory for
// this skill: …"、后台 agent 完成的 <task-notification>、Stop hook 的反馈、
// "Continue from where you left off."）。把它们误判成 turn-start 的后果不是多
// 一个节点那么轻——它会把**后续 assistant 的最终回复整段劫走**挂到假 turn 上，
// 真 turn 只剩工具调用、response 为空，UI 里就是一条永远「正在生成…」的僵尸。
// 本机 337 个 turn 实测：修前 45 条空 response 带工具，其中 44 条是这么来的。
//
// 判据用结构字段、不用文本前缀白名单（前缀会随 CLI 版本漂）：
//   isMeta === true          —— 83 条注入全中，257 条真用户零误杀
//   promptSource === "system" —— task-notification 专属；真用户是 typed/sdk/queued
//   interruptedMessageId      —— Esc 打断的占位消息（全库 522 条），这两个字段都没有
//   isCompactSummary / isVisibleInTranscriptOnly —— /compact 注入的历史摘要
// isCommandNoise 的文本闸留作老版本 jsonl 的兜底（那时还没有这些字段）。
export function isTurnStart(e: CliRawEntry): boolean {
  if (e.type !== "user") return false;
  if (isToolResultEntry(e)) return false;
  if (e.isMeta === true) return false;
  if (e.promptSource === "system") return false;
  if (e.interruptedMessageId !== undefined) return false;
  if (e.isCompactSummary === true) return false;
  if (e.isVisibleInTranscriptOnly === true) return false;
  const text = userText(e);
  if (!text || !text.trim()) return false;
  if (isCommandNoise(text)) return false;
  return true;
}

// 宽松判据：任何带文本的非 tool_result user 消息都能当 turn-start（含被严格
// 判据挡掉的 meta / system / 命令噪声）。只用于严格判据找不到主时的兜底。
// 绝不能放行 compact summary（那不是对话起点，否则会导致 turn-start 错配）。
export function looseTurnStart(e: CliRawEntry): boolean {
  if (e.type !== "user") return false;
  if (isToolResultEntry(e)) return false;
  if (e.isCompactSummary === true) return false;
  if (e.isVisibleInTranscriptOnly === true) return false;
  return Boolean(userText(e)?.trim());
}

// ── turn 归属 ───────────────────────────────────────────────────────────────

// byUuid 必须收**全部**带 uuid 的 entry（含 type:"system" 的 compact/边界标记）——
// CLI 在每个 turn 之间插 system 节点承载父链，过滤掉会把链打断、让每个 turn
// 变成孤根。ownerTurn 上溯时需穿过这些非对话节点继续走。
export function indexByUuid(
  entries: Iterable<CliRawEntry>,
): Map<string, CliRawEntry> {
  const byUuid = new Map<string, CliRawEntry>();
  for (const e of entries) if (typeof e.uuid === "string") byUuid.set(e.uuid, e);
  return byUuid;
}

// 每条 entry 归属哪个 turn-start（沿 parentUuid 上溯到最近的 turn-start）。
// 同一套上溯按不同判据跑两遍 —— 见 makeTurnOwnership 的取舍。
export function makeOwnerResolver(
  byUuid: Map<string, CliRawEntry>,
  isStart: (e: CliRawEntry) => boolean,
) {
  const turnOf = new Map<string, string | null>();
  return function ownerTurn(uuid: string): string | null {
    const cached = turnOf.get(uuid);
    if (cached !== undefined) return cached;
    const e = byUuid.get(uuid);
    if (!e) {
      turnOf.set(uuid, null);
      return null;
    }
    // 占位防环（坏 jsonl 自指）。
    turnOf.set(uuid, null);
    let owner: string | null;
    if (isStart(e)) owner = e.uuid as string;
    else owner = e.parentUuid ? ownerTurn(e.parentUuid) : null;
    turnOf.set(uuid, owner);
    return owner;
  };
}

export type TurnOwnership = {
  // 严格优先、宽松兜底的归属解析。
  resolveOwner: (uuid: string) => string | null;
  // 被宽松判据认领出来的兜底起点（import 侧要把它们一并组装成节点）。
  fallbackStartIds: Set<string>;
};

// 兜底承载：`claude --continue` / fork 出来的 jsonl，开头可能压根没有真用户
// 提问（链头是 "Continue from where you left off." 这类 meta，甚至直接是
// assistant 片段）。严格判据下这些链上溯不到任何 turn-start，整段回复会被
// **静默丢弃** —— 本机实测 117 条消息 / 16030 字符。所以严格找不到主时退一步
// 用宽松判据认领，让内容有处可去。
//
// 次序不能反：先严格、后宽松。反过来 meta 消息就会重新抢走已经有主的 turn 的
// 文本 —— 那正是这套判据当初要修的 bug 本身。
export function makeTurnOwnership(
  byUuid: Map<string, CliRawEntry>,
): TurnOwnership {
  const strictOwner = makeOwnerResolver(byUuid, isTurnStart);
  const looseOwner = makeOwnerResolver(byUuid, looseTurnStart);
  const fallbackStartIds = new Set<string>();
  function resolveOwner(uuid: string): string | null {
    const strict = strictOwner(uuid);
    if (strict) return strict;
    const loose = looseOwner(uuid);
    if (loose) fallbackStartIds.add(loose);
    return loose;
  }
  return { resolveOwner, fallbackStartIds };
}

// ── 带行号的整文件读取（截前缀用）──────────────────────────────────────────

// 与 cli-import 的宽容读取不同：这里任何一行 JSON 坏掉就整体放弃。截前缀是要
// **原样复制**这些行去造一个新会话，读漏一行等于造出一个内容缺失的 lineage，
// 宁可不分叉（调用方降级线性 resume）也不能造错。
export function readJsonlLines(jsonlPath: string): CliRawLine[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const out: CliRawLine[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push({ lineIndex: i, entry: JSON.parse(line) as CliRawEntry });
    } catch {
      return null;
    }
  }
  return out;
}

// 某个 turn 的**末条** assistant 行 —— 前缀 jsonl 切到这里为止。
// turnId 是 import 定的节点 id（= turn-start entry 的 uuid），所以归属判据必须
// 和 import 用同一套，否则切点会落在别的 turn 里或干脆找不到。
export function terminalAssistantLine(
  rawLines: CliRawLine[],
  turnId: string,
): CliRawLine | null {
  const byUuid = indexByUuid(rawLines.map((l) => l.entry));
  const { resolveOwner } = makeTurnOwnership(byUuid);

  function depth(uuid: string): number {
    const seen = new Set<string>();
    let cur: string | null | undefined = uuid;
    let n = 0;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      n++;
      cur = byUuid.get(cur)?.parentUuid;
    }
    return n;
  }

  let best: CliRawLine | null = null;
  for (const line of rawLines) {
    const uuid = line.entry.uuid;
    if (
      typeof uuid !== "string" ||
      line.entry.type !== "assistant" ||
      line.entry.isSidechain === true ||
      resolveOwner(uuid) !== turnId
    ) {
      continue;
    }
    if (!best) {
      best = line;
      continue;
    }
    const d = depth(uuid);
    const bd = depth(best.entry.uuid as string);
    if (
      d > bd ||
      (d === bd && ms(line.entry.timestamp) > ms(best.entry.timestamp)) ||
      (d === bd &&
        ms(line.entry.timestamp) === ms(best.entry.timestamp) &&
        line.lineIndex > best.lineIndex)
    ) {
      best = line;
    }
  }
  return best;
}

// 从 tailUuid 沿 parentUuid 一路上溯收集要保留的 uuid 集合。自指/成环返回 null。
export function keepUuidChain(
  rawLines: CliRawLine[],
  tailUuid: string,
): Set<string> | null {
  const byUuid = indexByUuid(rawLines.map((l) => l.entry));
  const keep = new Set<string>();
  let cur: string | null | undefined = tailUuid;
  while (cur) {
    if (keep.has(cur)) return null;
    keep.add(cur);
    cur = byUuid.get(cur)?.parentUuid;
  }
  return keep;
}
