// CLI session jsonl → trellis 节点树 解析器（Stage A，纯函数，无 DB / 无 server-only）。
//
// Claude Code CLI 把每个会话存成 ~/.claude/projects/<encoded-cwd>/<sid>.jsonl，
// 每行一条 entry，靠 parentUuid 串成链（rewind/edit 才分叉）。本模块把一个 jsonl
// collapse 成 trellis 的 Q/A 节点树：一条「真·user 文本消息」开一个节点，到下一条
// 真 user 文本之间的 assistant 行折成 response + toolCalls。详见 progress/cli-sync.md。
//
// 纯解析、不写库 —— DB 落地 + 增量 watcher 在 Stage B 单独接。这样解析逻辑可脱离
// 服务端独立验证（node --experimental-strip-types）。
import fs from "node:fs";
import type { ToolCall } from "@/lib/types";

// ── jsonl entry 形状（只声明用到的字段，其余忽略）────────────────────────────
type ContentBlock = {
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
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};
type RawEntry = {
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
  message?: { role?: string; content?: string | ContentBlock[]; usage?: Usage };
};

export type ParsedTurn = {
  // 节点 id = 该 turn 首条 user entry 的 uuid（确定性 → 重复导入幂等）。
  id: string;
  parentId: string | null;
  siblingIndex: number;
  question: string;
  response: string;
  toolCalls: ToolCall[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    contextTokens: number | null;
  };
  createdAt: number;
};

export type ParsedCliSession = {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  // 文件里最后一条带 uuid 的 entry —— 增量游标：watcher 比对它判断有无新增。
  lastUuid: string | null;
  // 文件里出现过的**全部** entry uuid。落库层拿它判断「某个已有节点是不是当年由
  // import 从这个 jsonl 建出来的」—— import 建的节点 id 恒等于某条 entry 的 uuid，
  // 而 trellis 自己建的节点 id 是本地生成的 v4，绝不会出现在 jsonl 里。这是清理
  // 存量假 turn 时唯一既准又不会误伤用户数据的判据。
  entryUuids: string[];
  turns: ParsedTurn[];
};

// ── helpers ─────────────────────────────────────────────────────────────────

function ms(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function userText(e: RawEntry): string | null {
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

function isToolResultEntry(e: RawEntry): boolean {
  const c = e.message?.content;
  return Array.isArray(c) && c.some((b) => b.type === "tool_result");
}

// CLI 注入的命令/系统行不是真用户提问 —— 过滤掉。
function isCommandNoise(text: string): boolean {
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
function isTurnStart(e: RawEntry): boolean {
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

// tool_result 的 content → 展平成字符串（string 直用；array 取 text 块拼接）。
function toolResultString(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) =>
        typeof x === "string"
          ? x
          : x && typeof x === "object" && "text" in x
            ? String((x as { text: unknown }).text)
            : JSON.stringify(x),
      )
      .join("\n");
  }
  return String(content);
}

// ── 主解析 ──────────────────────────────────────────────────────────────────

export function parseCliSessionJsonl(
  jsonlPath: string,
): ParsedCliSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }

  const all: RawEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as RawEntry);
    } catch {
      /* 跳过坏行 */
    }
  }

  // 会话级元数据：sessionId（兜底用文件名）/ cwd / gitBranch / ai-title。
  const sessionId =
    all.find((e) => e.sessionId)?.sessionId ??
    jsonlPath.replace(/^.*\//, "").replace(/\.jsonl$/, "");
  const cwd = all.find((e) => e.cwd)?.cwd ?? null;
  const gitBranch = all.find((e) => e.gitBranch)?.gitBranch ?? null;
  const aiTitle =
    [...all].reverse().find((e) => e.type === "ai-title")?.aiTitle ?? null;

  // 对话行：turn-start / member 只认 user/assistant；v1 丢弃 sidechain。
  const entries = all.filter(
    (e) =>
      e.uuid &&
      (e.type === "user" || e.type === "assistant") &&
      e.isSidechain !== true,
  );
  if (entries.length === 0) return null;

  // byUuid 收全部带 uuid 的 entry（含 type:"system" 的 compact/边界标记）——
  // CLI 在每个 turn 之间插 system 节点承载父链，过滤掉会把链打断、让每个 turn
  // 变成孤根。ownerTurn 上溯时需穿过这些非对话节点继续走。
  const byUuid = new Map<string, RawEntry>();
  for (const e of all) if (e.uuid) byUuid.set(e.uuid, e);

  // 每条 entry 归属哪个 turn-start（沿 parentUuid 上溯到最近的 turn-start）。
  // 同一套上溯跑两遍，判据不同 —— 见下面 resolveOwner 的取舍。
  function makeOwnerResolver(isStart: (e: RawEntry) => boolean) {
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

  const strictOwner = makeOwnerResolver(isTurnStart);
  // 宽松判据：任何带文本的非 tool_result user 消息都能当 turn-start（含被严格
  // 判据挡掉的 meta / system / 命令噪声）。
  const looseOwner = makeOwnerResolver(
    (e) =>
      e.type === "user" && !isToolResultEntry(e) && Boolean(userText(e)?.trim()),
  );

  // 兜底承载：`claude --continue` / fork 出来的 jsonl，开头可能压根没有真用户
  // 提问（链头是 "Continue from where you left off." 这类 meta，甚至直接是
  // assistant 片段）。严格判据下这些链上溯不到任何 turn-start，整段回复会被
  // **静默丢弃** —— 本机实测 117 条消息 / 16030 字符。所以严格找不到主时退一步
  // 用宽松判据认领，让内容有处可去；这类兜底 turn-start 会被记进
  // fallbackStartIds 一并组装成节点。
  //
  // 次序不能反：先严格、后宽松。反过来 meta 消息就会重新抢走已经有主的 turn 的
  // 文本 —— 那正是这次要修的 bug 本身。
  const fallbackStartIds = new Set<string>();
  function resolveOwner(uuid: string): string | null {
    const strict = strictOwner(uuid);
    if (strict) return strict;
    const loose = looseOwner(uuid);
    if (loose) fallbackStartIds.add(loose);
    return loose;
  }

  // 全局 tool_result 索引：tool_use_id → { 输出文本, is_error, stderr }。
  const resultById = new Map<
    string,
    { output: string | null; isError: boolean; stderr: string | null }
  >();
  for (const e of entries) {
    if (e.type !== "user") continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === "tool_result" && b.tool_use_id) {
        const tur = e.toolUseResult as { stderr?: string } | undefined;
        resultById.set(b.tool_use_id, {
          output: toolResultString(b.content),
          isError: b.is_error === true,
          stderr: tur?.stderr ? tur.stderr : null,
        });
      }
    }
  }

  // 先归属、后收集 turn-start —— 归属过程会往 fallbackStartIds 里补兜底起点。
  const membersByTurn = new Map<string, RawEntry[]>();
  for (const e of entries) {
    if (e.type !== "assistant") continue;
    const owner = resolveOwner(e.uuid as string);
    if (!owner) continue;
    (membersByTurn.get(owner) ?? membersByTurn.set(owner, []).get(owner)!).push(
      e,
    );
  }

  // 认领兜底起点要跑到固定点：一个 turn 的 parent 上溯也可能只在宽松判据下有主，
  // 那会**再**认领一个链头出来。只跑一轮的话，后认领的那个不在 starts 里，指向它
  // 的 parentId 就成了断链。fallbackStartIds 只增不减 + resolveOwner 带缓存，
  // 所以循环必然收敛，重复调用近乎零成本。
  let starts: RawEntry[] = [];
  let claimed = -1;
  while (claimed !== fallbackStartIds.size) {
    claimed = fallbackStartIds.size;
    starts = entries.filter(
      (e) => isTurnStart(e) || fallbackStartIds.has(e.uuid as string),
    );
    for (const s of starts) if (s.parentUuid) resolveOwner(s.parentUuid);
  }

  const turns: ParsedTurn[] = [];
  for (const start of starts) {
    const id = start.uuid as string;
    const members = (membersByTurn.get(id) ?? []).sort(
      (a, b) => ms(a.timestamp) - ms(b.timestamp),
    );

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let lastUsage: Usage | undefined;
    for (const m of members) {
      const startedAt = ms(m.timestamp);
      const c = m.message?.content;
      if (m.message?.usage) lastUsage = m.message.usage;
      if (typeof c === "string") {
        if (c.trim()) textParts.push(c);
        continue;
      }
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === "text" && b.text?.trim()) {
          textParts.push(b.text);
        } else if (b.type === "tool_use" && b.id) {
          const res = resultById.get(b.id);
          toolCalls.push({
            id: b.id,
            name: b.name ?? "tool",
            input: b.input ?? null,
            output: res?.output ?? null,
            stderr: res?.stderr ?? null,
            status: res ? (res.isError ? "error" : "done") : "done",
            durationMs: null,
            startedAt,
            endedAt: startedAt,
          });
        }
        // thinking 块 v1 丢弃。
      }
    }

    const parentTurn = start.parentUuid ? resolveOwner(start.parentUuid) : null;
    turns.push({
      id,
      parentId: parentTurn,
      siblingIndex: 0, // 下面按 parent 分组回填
      question: userText(start) ?? "",
      response: textParts.join("\n\n"),
      toolCalls,
      tokens: {
        input: lastUsage?.input_tokens ?? 0,
        output: lastUsage?.output_tokens ?? 0,
        cacheRead: lastUsage?.cache_read_input_tokens ?? 0,
        cacheCreation: lastUsage?.cache_creation_input_tokens ?? 0,
        contextTokens: lastUsage
          ? (lastUsage.input_tokens ?? 0) +
            (lastUsage.cache_read_input_tokens ?? 0) +
            (lastUsage.cache_creation_input_tokens ?? 0)
          : null,
      },
      createdAt: ms(start.timestamp),
    });
  }

  // 剪掉不承载任何东西的兜底 turn。兜底起点只是"内容的临时挂靠点"，不是用户
  // 真提过的问题；既没回复也没工具时它纯粹是树里的空壳。子 turn 提升到被剪者的
  // parent（直接删会留下断链的 parentId —— 实测会造出 9 个孤儿）。严格 turn 不
  // 参与剪枝：那是真用户提问，还没答上也得显示（正在跑的末轮就长这样）。
  const prunable = new Set(
    turns
      .filter(
        (t) =>
          fallbackStartIds.has(t.id) &&
          !t.response.trim() &&
          t.toolCalls.length === 0,
      )
      .map((t) => t.id),
  );
  let kept = turns;
  if (prunable.size > 0) {
    const byId = new Map(turns.map((t) => [t.id, t]));
    const lift = (pid: string | null): string | null => {
      let cur = pid;
      // guard：坏 jsonl 的自指环。
      for (let i = 0; cur && prunable.has(cur) && i < turns.length; i++) {
        cur = byId.get(cur)?.parentId ?? null;
      }
      return cur;
    };
    for (const t of turns) t.parentId = lift(t.parentId);
    kept = turns.filter((t) => !prunable.has(t.id));
  }

  // siblingIndex：同 parent 下按 createdAt 排序赋序号。
  const byParent = new Map<string | null, ParsedTurn[]>();
  for (const t of kept) {
    (byParent.get(t.parentId) ?? byParent.set(t.parentId, []).get(t.parentId)!).push(t);
  }
  for (const group of byParent.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt);
    group.forEach((t, i) => (t.siblingIndex = i));
  }

  if (kept.length === 0) return null;

  const times = kept.map((t) => t.createdAt).filter((t) => t > 0);
  const title =
    aiTitle ??
    (kept[0].question.replace(/\s+/g, " ").trim().slice(0, 60) || "未命名会话");

  const lastUuid =
    [...all].reverse().find((e) => typeof e.uuid === "string")?.uuid ?? null;
  const entryUuids = all
    .map((e) => e.uuid)
    .filter((u): u is string => typeof u === "string");

  return {
    sessionId,
    entryUuids,
    cwd,
    gitBranch,
    title,
    createdAt: times.length ? Math.min(...times) : 0,
    updatedAt: times.length ? Math.max(...times) : 0,
    lastUuid,
    turns: kept,
  };
}
