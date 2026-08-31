// Regression harness for lib/server/cli-jsonl.ts —— CLI jsonl 的 turn 归属。
//
// 这个文件存在的理由是一次真实漂移：cli-import（jsonl → 节点树）和 cli-fork
// （在某个 turn 上截前缀造分叉）各抄了一份 turn-start 判据，import 那份后来长出
// 5 道结构闸，fork 那份没跟。两边对「turn 从哪开始」的答案分家后，fork 的入参
// turnUuid 恰恰是 import 定的节点 id —— 等于在一条自己认不出的 turn 上截前缀。
//
// 2026-08-01 合并前实测（889 个 jsonl / 1897 个有回答的 turn）：
//   36 个 turn（1.90%）fork 侧找不到 tail   → 分叉静默降级成线性
//   315 个 turn（16.61%）选出的 tail 与 import 归属不符 → 前缀截在没说完的回答中间
// 合并后两项均为 0。本 harness 就是防它再分家 —— 判据不能只靠注释约定。
//
// Run:  bun scripts/test-cli-jsonl.ts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CliRawEntry,
  indexByUuid,
  isTurnStart,
  looseTurnStart,
  makeTurnOwnership,
  readJsonlLines,
  slashCommandQuestion,
  terminalAssistantLine,
  userText,
} from "@/lib/server/cli-jsonl";
import { parseCliSessionJsonl } from "@/lib/server/cli-import";
import { historyLivesInCliSession } from "@/lib/llm/prompt";

let failures = 0;
function check(label: string, ok: boolean, got?: unknown) {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(
      `  ✗ ${label}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`,
    );
  }
}

function section(name: string) {
  console.log(`\n── ${name}`);
}

// ── 合成语料工具 ────────────────────────────────────────────────────────────

let seq = 0;
function uid(tag: string): string {
  seq++;
  return `${tag}-${String(seq).padStart(4, "0")}`;
}

function user(
  uuid: string,
  parentUuid: string | null,
  text: string,
  extra: Partial<CliRawEntry> = {},
): CliRawEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-08-01T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  };
}

function assistant(
  uuid: string,
  parentUuid: string | null,
  text: string,
  extra: Partial<CliRawEntry> = {},
): CliRawEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-08-01T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  };
}

function writeFixture(entries: CliRawEntry[]): string {
  const dir = path.join(os.tmpdir(), "trellis-cli-jsonl-test");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${uid("fx")}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

// ── 1. turn-start 的结构闸 ──────────────────────────────────────────────────
// 每道闸各一条：CLI 注入的假提问必须被挡下。挡漏任何一道，后续 assistant 的最终
// 回复就会被劫走挂到假 turn 上（真 turn 只剩工具调用、response 为空）。
{
  section("turn-start 的结构闸");
  check("真用户提问认得出", isTurnStart(user(uid("u"), null, "帮我看下这个报错")));

  const gates: [string, Partial<CliRawEntry>][] = [
    ["isMeta", { isMeta: true }],
    ["promptSource=system", { promptSource: "system" }],
    ["interruptedMessageId", { interruptedMessageId: "abc" }],
    ["isCompactSummary", { isCompactSummary: true }],
    ["isVisibleInTranscriptOnly", { isVisibleInTranscriptOnly: true }],
  ];
  for (const [name, extra] of gates) {
    check(
      `${name} 挡下 CLI 注入`,
      !isTurnStart(user(uid("u"), null, "Continue from where you left off.", extra)),
    );
  }

  check(
    "命令噪声挡下（老版本 jsonl 兜底）",
    !isTurnStart(user(uid("u"), null, "<command-name>/clear</command-name>")),
  );
  check(
    "tool_result 不是 turn-start",
    !isTurnStart({
      type: "user",
      uuid: uid("u"),
      parentUuid: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    }),
  );
  check("空文本不是 turn-start", !isTurnStart(user(uid("u"), null, "   ")));

  // 宽松判据必须恰好放行严格判据挡下的那些（兜底才有东西可认领），但不认 compact 摘要。
  check(
    "宽松判据放行 meta",
    looseTurnStart(user(uid("u"), null, "Continue…", { isMeta: true })),
  );
  check(
    "宽松判据不认 compact summary",
    !looseTurnStart(
      user(uid("u"), null, "Continue from where you left off.", {
        isCompactSummary: true,
      }),
    ),
  );
  check(
    "宽松判据不认 isVisibleInTranscriptOnly",
    !looseTurnStart(
      user(uid("u"), null, "Continue from where you left off.", {
        isVisibleInTranscriptOnly: true,
      }),
    ),
  );
  check(
    "宽松判据同样不认 tool_result",
    !looseTurnStart({
      type: "user",
      uuid: uid("u"),
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
      },
    }),
  );
}

// ── 2. 历史 bug：假 turn-start 劫走真 turn 的回复 ───────────────────────────
{
  section("假 turn-start 不许劫走真 turn 的回复");

  const q = uid("q");
  const meta = uid("m");
  const a1 = uid("a");
  const a2 = uid("a");
  // 真提问 → CLI 注入的 meta（长得像提问）→ 两条 assistant。
  // 3 道闸的老判据会把 meta 当 turn-start，于是 a1/a2 全挂到 meta 上，
  // 真 turn q 的 tail 变成 null（分叉直接降级）。
  const entries = [
    user(q, null, "帮我把这个函数重构一下"),
    user(meta, q, "Base directory for this skill: /Users/x/.claude/skills/foo", {
      isMeta: true,
    }),
    assistant(a1, meta, "好的，我先读一下文件"),
    assistant(a2, a1, "重构完成，改了三处"),
  ];
  const p = writeFixture(entries);
  const rawLines = readJsonlLines(p)!;

  const tail = terminalAssistantLine(rawLines, q);
  check("真 turn 找得到 tail", tail !== null);
  check("tail 是最后一条 assistant", tail?.entry.uuid === a2, tail?.entry.uuid);

  const { resolveOwner } = makeTurnOwnership(indexByUuid(entries));
  check("两条 assistant 都归真 turn", resolveOwner(a1) === q && resolveOwner(a2) === q, {
    a1: resolveOwner(a1),
    a2: resolveOwner(a2),
  });

  // 同一份语料走 import：回复必须落在真 turn 上，不能出现空 response 的僵尸。
  const parsed = parseCliSessionJsonl(p);
  const turn = parsed?.turns.find((t) => t.id === q);
  check("import 也把回复归给真 turn", Boolean(turn?.response.includes("重构完成")), turn?.response);
  check("没有空 response 的僵尸 turn", (parsed?.turns ?? []).every((t) => t.response.trim() !== ""));
}

// ── 3. 宽松兜底：链头没有真提问时内容不许被丢 ───────────────────────────────
{
  section("宽松兜底承载 --continue / fork 出来的 jsonl");

  const meta = uid("m");
  const a1 = uid("a");
  // `claude --continue` 出来的 jsonl：链头就是 meta，严格判据下上溯不到任何
  // turn-start。没有兜底的话整段回复会被静默丢弃（实测 117 条消息 / 16030 字符）。
  const entries = [
    user(meta, null, "Continue from where you left off.", { isMeta: true }),
    assistant(a1, meta, "接着上次的进度，我继续处理剩下两个文件"),
  ];
  const p = writeFixture(entries);

  const { resolveOwner, fallbackStartIds } = makeTurnOwnership(indexByUuid(entries));
  check("兜底把 meta 认领成起点", resolveOwner(a1) === meta, resolveOwner(a1));
  check("认领记进 fallbackStartIds", fallbackStartIds.has(meta));

  const parsed = parseCliSessionJsonl(p);
  check("import 不丢这段回复", Boolean(parsed?.turns.some((t) => t.response.includes("继续处理"))));

  const rawLines = readJsonlLines(p)!;
  check("fork 也能在兜底 turn 上截前缀", terminalAssistantLine(rawLines, meta) !== null);
}

// ── 4. Compact Continuation：长动线上下文压缩后不丢最终回复且不断链 ─────────
{
  section("Compact Continuation 拓扑桥接与最终答复保留");

  const q1 = uid("q");
  const t1 = uid("a");
  const tr1 = uid("u");
  const sysCompact = uid("s");
  const compactSummary = uid("u");
  const att1 = uid("att");
  const aFinal = uid("a");
  const q2 = uid("q");
  const a2 = uid("a");

  // 场景：Turn 1 发起 -> 工具调用 -> 触发自动 Compact (system parent null + isCompactSummary)
  // -> Attachments -> 最终答复 aFinal -> Turn 2 发起 q2 -> 回答 a2
  const entries: CliRawEntry[] = [
    user(q1, null, "帮我分析全景车信与拓扑的过滤逻辑"),
    assistant(t1, q1, "", {
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }],
      },
    }),
    user(tr1, t1, "", {
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "file content" }],
      },
    }),
    // Compact 块
    {
      type: "system",
      uuid: sysCompact,
      parentUuid: null,
      message: { role: "system", content: [] },
    },
    user(compactSummary, sysCompact, "This session is being continued from a previous conversation...", {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
    {
      type: "attachment",
      uuid: att1,
      parentUuid: compactSummary,
    },
    assistant(aFinal, att1, "在当前的架构中，路网车信数据主要分为两个层级..."),
    // 下一轮
    user(q2, aFinal, "所以是完全匹配才算挂上吗？"),
    assistant(a2, q2, "是的，只有完全重合的拓扑才会挂接。"),
  ];

  const p = writeFixture(entries);
  const byUuid = indexByUuid(entries);
  const { resolveOwner } = makeTurnOwnership(byUuid);

  check("Compact 内的最终答复归属于 Turn 1", resolveOwner(aFinal) === q1, resolveOwner(aFinal));
  check("Turn 2 的 parentTurn 归属于 Turn 1", resolveOwner(q2) === q2);

  const parsed = parseCliSessionJsonl(p);
  check("解析出正好 2 个有效 Turn（无伪 Turn 节点）", parsed?.turns.length === 2, parsed?.turns.length);

  const turn1 = parsed?.turns.find((t) => t.id === q1);
  const turn2 = parsed?.turns.find((t) => t.id === q2);

  check("Turn 1 包含工具调用记录", (turn1?.toolCalls.length ?? 0) === 1);
  check("Turn 1 成功保留 Compact 后的最终文本回复", Boolean(turn1?.response.includes("路网车信数据主要分为两个层级")), turn1?.response);
  check("Turn 2 的 parentId 正确指向 Turn 1（拓扑不裂成根）", turn2?.parentId === q1, turn2?.parentId);

  const rawLines = readJsonlLines(p)!;
  const tail1 = terminalAssistantLine(rawLines, q1);
  check("Turn 1 截前缀 tail 正确指向 Compact 后的 aFinal", tail1?.entry.uuid === aFinal, tail1?.entry.uuid);
}

// ── 4b. slash command 轮：skill 命令是真 turn，本地命令仍是噪声 ─────────────
// 事故（2026-08-31）：用户在节点上执行 /writecraft，包装行被 isCommandNoise 滤掉、
// skill 正文被 isMeta 闸滤掉 → 整轮 turn 漏解析 → backfillNativeTurnUuid 永远
// 配不上 cli_turn_uuid → 下一问降级 fresh session。判据只能看图不能看文本：
// /clear 和 /writecraft 的包装行长得一模一样。
{
  section("slash command 轮次识别");

  // skill 型（实测形态，2.1.207）：包装行 → isMeta 技能正文 → assistant。
  const cmd = uid("q");
  const skillMeta = uid("m");
  const sa1 = uid("a");
  const sa2 = uid("a");
  const nextQ = uid("q");
  const na = uid("a");
  const skillEntries = [
    user(
      cmd,
      null,
      "<command-message>writecraft</command-message>\n<command-name>/writecraft</command-name>\n<command-args>写一篇飞书云文档</command-args>",
    ),
    user(skillMeta, cmd, "Base directory for this skill: /Users/x/.claude/skills/writecraft\n\n# writecraft…", {
      isMeta: true,
    }),
    assistant(sa1, skillMeta, "好的，先对齐五轴坐标"),
    assistant(sa2, sa1, "成稿如下：飞书云文档……"),
    // 追问轮：验证 parent 链上挂得回 skill 命令 turn。
    user(nextQ, sa2, "开始吧"),
    assistant(na, nextQ, "开始。"),
  ];
  const p = writeFixture(skillEntries);
  const { resolveOwner } = makeTurnOwnership(indexByUuid(skillEntries));
  check("skill 命令的回复归命令 turn", resolveOwner(sa2) === cmd, resolveOwner(sa2));

  const parsed = parseCliSessionJsonl(p);
  const cmdTurn = parsed?.turns.find((t) => t.id === cmd);
  check("import 解析出 skill 命令 turn（uuid 可回填）", Boolean(cmdTurn));
  check(
    "question 还原成键入原文（backfill includes 匹配成立）",
    cmdTurn?.question === "/writecraft 写一篇飞书云文档",
    cmdTurn?.question,
  );
  check(
    "question.includes(节点原文) —— backfillNativeTurnUuid 的实际判据",
    Boolean(cmdTurn?.question.includes("/writecraft 写一篇飞书云文档")),
  );
  check("回复文本落在命令 turn 上", Boolean(cmdTurn?.response.includes("成稿如下")));
  const nextTurn = parsed?.turns.find((t) => t.id === nextQ);
  check("追问轮 parentId 指向命令 turn（树不断链）", nextTurn?.parentId === cmd, nextTurn?.parentId);

  const rawLines = readJsonlLines(p)!;
  const tail = terminalAssistantLine(rawLines, cmd);
  check("fork 能在命令 turn 上找到 tail（import↔fork 同判据）", tail?.entry.uuid === sa2, tail?.entry.uuid);

  // 本地命令（/clear /model …）：包装行 → <local-command-stdout> / system，无
  // assistant 产出 —— 仍是噪声，不许长出空壳节点。
  const q1 = uid("q");
  const a1 = uid("a");
  const clearCmd = uid("q");
  const sysNode = uid("s");
  const q2 = uid("q");
  const a2 = uid("a");
  const modelCmd = uid("q");
  const stdout = uid("u");
  const localEntries: CliRawEntry[] = [
    user(q1, null, "先聊两句"),
    assistant(a1, q1, "好。"),
    user(
      clearCmd,
      a1,
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
    ),
    { type: "system", uuid: sysNode, parentUuid: clearCmd, message: { role: "system", content: [] } },
    user(q2, sysNode, "清完了，新话题"),
    assistant(a2, q2, "新话题收到。"),
    user(
      modelCmd,
      a2,
      "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>",
    ),
    user(stdout, modelCmd, "<local-command-stdout>Set model to Opus</local-command-stdout>"),
  ];
  const lp = writeFixture(localEntries);
  const lparsed = parseCliSessionJsonl(lp);
  check(
    "本地命令不长成 turn（/clear /model 仍是噪声）",
    Boolean(lparsed && lparsed.turns.every((t) => t.id !== clearCmd && t.id !== modelCmd)),
    lparsed?.turns.map((t) => t.id),
  );
  check("本地命令穿插不影响真 turn 数", lparsed?.turns.length === 2, lparsed?.turns.length);

  // 真语料形态（eb68c287）：/clear → system → system → isMeta 的
  // <local-command-caveat> user。isMeta 证据必须过噪声闸，否则 /clear 复活成空 turn。
  const cq = uid("q");
  const ca = uid("a");
  const clr = uid("q");
  const sys1 = uid("s");
  const sys2 = uid("s");
  const caveat = uid("u");
  const caveatEntries: CliRawEntry[] = [
    user(cq, null, "随便聊聊"),
    assistant(ca, cq, "好。"),
    user(clr, ca, "<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
    { type: "system", uuid: sys1, parentUuid: clr, message: { role: "system", content: [] } },
    { type: "system", uuid: sys2, parentUuid: sys1, message: { role: "system", content: [] } },
    user(caveat, sys2, "<local-command-caveat>Caveat: The messages below were generated by…</local-command-caveat>", {
      isMeta: true,
    }),
  ];
  const cvp = writeFixture(caveatEntries);
  const cvParsed = parseCliSessionJsonl(cvp);
  check(
    "/clear 隔 system 挂 isMeta caveat 仍是噪声（真语料回归）",
    Boolean(cvParsed && cvParsed.turns.every((t) => t.id !== clr)),
    cvParsed?.turns.map((t) => t.id),
  );

  // slashCommandQuestion 的还原语义。
  check(
    "无参命令还原为 /name",
    slashCommandQuestion("<command-message>fenjue</command-message>\n<command-name>/fenjue</command-name>") ===
      "/fenjue",
  );
  check("普通文本不还原", slashCommandQuestion("帮我看下这个报错") === null);
}

// ── 4c. lineage 降级时的 prompt 折叠判定（claude.ts / codex.ts 共用闸）──────
{
  section("historyLivesInCliSession（降级 fresh session 必须折叠历史）");
  const h = [{ role: "user" as const, content: "q1" }, { role: "assistant" as const, content: "a1" }];
  check("有 resume id → 历史住 CLI session", historyLivesInCliSession({ claudeSessionId: "sid", history: h }));
  check("fresh 且无历史（root 首轮）→ 不折叠", historyLivesInCliSession({ claudeSessionId: null, history: [] }));
  check(
    "fresh 且有历史（lineage 降级）→ 必须折叠",
    !historyLivesInCliSession({ claudeSessionId: null, history: h }),
  );
}

// ── 5. import ↔ fork 边界一致（真语料全扫）─────────────────────────────────
// 这是本 harness 的主断言：import 造出来的每个 turn，fork 都必须能在**同一条**
// turn 上找到 tail。两边判据一分家这里立刻红。
{
  section("import ↔ fork 边界一致（真语料）");

  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) {
    console.log("  ⊘ ~/.claude/projects 不存在，跳过真语料扫描（合成断言已覆盖判据本身）");
  } else {
    const files: string[] = [];
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      let st: fs.Stats;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".jsonl")) files.push(path.join(dir, f));
      }
    }

    let turns = 0;
    let noTail = 0;
    let wrongTurn = 0;
    const badSamples: string[] = [];

    for (const f of files) {
      const parsed = parseCliSessionJsonl(f);
      if (!parsed || parsed.turns.length === 0) continue;
      const rawLines = readJsonlLines(f);
      if (!rawLines) continue;

      for (const t of parsed.turns) {
        // 只看「有回答、UI 上看得见」的 turn —— 那些才是用户能点分叉的。
        if (!t.response.trim()) continue;
        turns++;
        const tail = terminalAssistantLine(rawLines, t.id);
        if (!tail) {
          noTail++;
          if (badSamples.length < 3) {
            badSamples.push(`${path.basename(f)} turn=${t.id.slice(0, 8)} (no tail)`);
          }
          continue;
        }
        // tail 必须真属于这个 turn —— 它的文本应当出现在 import 组装的 response 里。
        // 纯工具调用的收尾 assistant 行没有文本，跳过（无从比对，也无从出错）。
        const text = userText(tail.entry)?.trim();
        if (text && !t.response.includes(text)) {
          wrongTurn++;
          if (badSamples.length < 3) {
            badSamples.push(`${path.basename(f)} turn=${t.id.slice(0, 8)} (tail 不属于该 turn)`);
          }
        }
      }
    }

    console.log(`  · 扫了 ${files.length} 个 jsonl / ${turns} 个有回答的 turn（全量，无抽样）`);
    check("每个可见 turn 都找得到 tail", noTail === 0, noTail);
    check("每个 tail 都属于该 turn", wrongTurn === 0, wrongTurn);
    for (const s of badSamples) console.log(`      ${s}`);
  }
}

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
