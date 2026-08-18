// Codex rollout -> Trellis attach regression harness.
//
// Covers the migration path without touching ~/.codex or calling a model:
// visible-turn parsing, duplicate assistant-event collapse, tool/token mapping,
// isolated SQLite import/update, and prefix rollout construction for branching.
//
// Run: bun run test:codex-cli

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-codex-import-"));
const dbPath = path.join(root, "trellis.db");
process.env.CODEX_HOME = path.join(root, "codex-home");
const rolloutDir = path.join(
  process.env.CODEX_HOME,
  "sessions",
  "2026",
  "08",
  "18",
);
fs.mkdirSync(rolloutDir, { recursive: true });
const bundledSkillDir = path.join(
  process.env.CODEX_HOME,
  "skills",
  ".system",
  "fixture-bundled",
);
const projectSkillDir = path.join(root, ".agents", "skills", "fixture-project");
fs.mkdirSync(bundledSkillDir, { recursive: true });
fs.mkdirSync(projectSkillDir, { recursive: true });
fs.writeFileSync(
  path.join(bundledSkillDir, "SKILL.md"),
  "---\nname: fixture-bundled\ndescription: bundled fixture\n---\n",
);
fs.writeFileSync(
  path.join(projectSkillDir, "SKILL.md"),
  "---\nname: fixture-project\ndescription: project fixture\n---\n",
);
process.env.TRELLIS_DB_PATH = dbPath;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? "  ✓" : "  ✗"} ${label}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`,
  );
}

const sid = crypto.randomUUID();
const turn1 = crypto.randomUUID();
const turn2 = crypto.randomUUID();
const toolId = "call_fixture_1";
const stamp = (second: number) => `2026-08-18T00:00:${String(second).padStart(2, "0")}.000Z`;
const entry = (
  second: number,
  type: string,
  payload: Record<string, unknown>,
) => JSON.stringify({ timestamp: stamp(second), type, payload });

const lines = [
  entry(0, "session_meta", {
    id: sid,
    session_id: sid,
    cwd: root,
    // Modern Codex embeds instructions on the first line. Keep this well over
    // the old 16 KiB discovery prefix so fixtures preserve that failure shape.
    base_instructions: "x".repeat(70 * 1024),
  }),
  // Injected role=user response_items are context, not visible user turns.
  entry(1, "response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<AGENTS.md>injected</AGENTS.md>" }],
  }),
  entry(2, "turn_context", { turn_id: turn1 }),
  entry(3, "event_msg", { type: "user_message", message: "第一问" }),
  entry(4, "response_item", {
    type: "message",
    role: "assistant",
    id: "response-1",
    content: [{ type: "output_text", text: "第一答" }],
  }),
  // Codex emits the same visible response on a second event channel.
  entry(5, "event_msg", { type: "agent_message", message: "第一答" }),
  entry(6, "response_item", {
    type: "custom_tool_call",
    call_id: toolId,
    name: "fixture_tool",
    input: JSON.stringify({ value: 7 }),
  }),
  entry(7, "response_item", {
    type: "custom_tool_call_output",
    call_id: toolId,
    output: "tool ok",
  }),
  entry(8, "event_msg", {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        cache_write_input_tokens: 3,
        output_tokens: 9,
      },
    },
  }),
  entry(9, "turn_context", { turn_id: turn2 }),
  entry(10, "event_msg", { type: "task_started", turn_id: turn2 }),
  entry(11, "event_msg", { type: "user_message", message: "第二问" }),
  entry(12, "response_item", {
    type: "message",
    role: "assistant",
    id: "response-2",
    content: [{ type: "output_text", text: "第二答" }],
  }),
  // Same response_item id must not duplicate output.
  entry(13, "response_item", {
    type: "message",
    role: "assistant",
    id: "response-2",
    content: [{ type: "output_text", text: "第二答" }],
  }),
];
const rolloutPath = path.join(
  rolloutDir,
  `rollout-2026-08-18T00-00-00-${sid}.jsonl`,
);
fs.writeFileSync(rolloutPath, `${lines.join("\n")}\n{incomplete`, "utf8");

try {
  const { parseCodexSessionJsonl } = await import("@/lib/server/codex-import");
  const { discoverLineage } = await import("@/lib/server/cli-discover");
  const { buildCodexPrefixRollout, codexLineageForNode } = await import(
    "@/lib/server/codex-fork"
  );
  const { attachSession, reimport } = await import(
    "@/lib/server/cli-sync-watcher"
  );
  const { importCliLineage } = await import("@/lib/server/cli-import-db");
  const { getDB } = await import("@/lib/server/sqlite");
  const { listSkills } = await import("@/lib/server/skills");
  const { resolveAgentSpawn } = await import("@/lib/server/agent-pack");
  const { modeToRunOptions } = await import("@/lib/llm/sdk-adapter");

  console.log("\n── Codex skills + Agent translation");
  const discoveredSkills = listSkills("codex", root);
  check(
    "发现 project .agents/skills",
    discoveredSkills.some((skill) => skill.name === "fixture-project"),
    true,
  );
  check(
    "发现 CODEX_HOME bundled skills",
    discoveredSkills.some((skill) => skill.name === "fixture-bundled"),
    true,
  );
  const codexAgent = resolveAgentSpawn(
    {
      id: "fixture-agent",
      slug: "fixture-agent",
      name: "Fixture",
      description: "",
      systemPrompt: "Use the fixture persona.",
      model: null,
      tools: ["Read"],
      disallowedTools: ["Bash"],
      skills: [{ kind: "inline", name: "inline-fixture", body: "Fixture skill body." }],
      inheritEnv: false,
      permission: "readonly",
      requireApproval: true,
      builtin: false,
      enabled: true,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    "codex",
    root,
  );
  check("Agent 翻译到 Codex runtime", codexAgent.runtime, "codex");
  check(
    "Codex Agent 内联挂载 skill",
    codexAgent.systemPrompt?.includes("Fixture skill body."),
    true,
  );
  check(
    "隔离 Agent 快照环境 skill",
    codexAgent.environmentSkillNames?.includes("fixture-project"),
    true,
  );
  const codexAgentOptions = modeToRunOptions("project", "gpt-5.5", {
    history: [],
    question: "fixture",
    agent: codexAgent,
  });
  check("Codex Agent 人设进入 system prompt", codexAgentOptions.systemPrompt, codexAgent.systemPrompt);
  check("Codex Agent 隔离环境 skills", codexAgentOptions.environmentSkills, false);
  check("Codex Agent 静态权限生效", codexAgentOptions.permission, "readonly");

  console.log("\n── rollout parser");
  const parsed = parseCodexSessionJsonl(rolloutPath)!;
  check("session id", parsed.sessionId, sid);
  check("只认两条可见 user_message", parsed.turns.length, 2);
  check("turn id 来自 turn_context", parsed.turns[0].id, turn1);
  check("线性 parent 链", parsed.turns[1].parentId, turn1);
  check("assistant 双通道去重", parsed.turns[0].response, "第一答");
  check("重复 response_item id 去重", parsed.turns[1].response, "第二答");
  check("tool call 成对", parsed.turns[0].toolCalls.length, 1);
  check("tool output", parsed.turns[0].toolCalls[0]?.output, "tool ok");
  check("净 input tokens", parsed.turns[0].tokens.input, 80);
  check("cache read tokens", parsed.turns[0].tokens.cacheRead, 20);
  check("cache write tokens", parsed.turns[0].tokens.cacheCreation, 3);

  console.log("\n── isolated DB attach");
  const attached = attachSession(rolloutPath, "codex");
  check("首次导入状态", attached.status, "imported");
  check("首次导入轮数", attached.turns, 2);
  const db = getDB();
  const session = db
    .prepare(
      "SELECT origin, cli_provider, model, context_mode, source_jsonl_path FROM sessions WHERE id = ?",
    )
    .get(sid) as Record<string, unknown>;
  check("origin=cli-import", session.origin, "cli-import");
  check("provider=codex", session.cli_provider, "codex");
  check("Codex model lock", session.model, "codex");
  check("带 cwd 的历史进入 project", session.context_mode, "project");
  check("保留 canonical rollout path", session.source_jsonl_path, rolloutPath);
  const nodes = db
    .prepare(
      "SELECT id, parent_id, claude_session_id, codex_session_id, codex_turn_ordinal FROM nodes WHERE session_id = ? ORDER BY created_at",
    )
    .all(sid) as Record<string, unknown>[];
  check("DB 节点数", nodes.length, 2);
  check("Claude lineage 保持空", nodes[0].claude_session_id, null);
  check("Codex lineage 写入", nodes[0].codex_session_id, sid);
  check("Codex ordinal 从 1 开始", nodes[0].codex_turn_ordinal, 1);
  check("第二轮 ordinal", nodes[1].codex_turn_ordinal, 2);
  const lineage = db
    .prepare(
      "SELECT cli_session_id, provider_family, is_root FROM cli_lineages WHERE trellis_session_id = ?",
    )
    .get(sid) as Record<string, unknown>;
  check("generic lineage id", lineage.cli_session_id, sid);
  check("lineage provider", lineage.provider_family, "codex");
  check("root lineage", lineage.is_root, 1);
  const firstLineage = codexLineageForNode(turn1)!;
  const secondLineage = codexLineageForNode(turn2)!;
  check("CODEX_HOME 下能定位 rollout", firstLineage.rolloutPath, rolloutPath);
  check("历史轮不是 tip", firstLineage.isRolloutTip, false);
  check("最新轮是 tip", secondLineage.isRolloutTip, true);

  console.log("\n── append update");
  const turn3 = crypto.randomUUID();
  fs.appendFileSync(
    rolloutPath,
    [
      "",
      entry(14, "turn_context", { turn_id: turn3 }),
      entry(15, "event_msg", { type: "user_message", message: "第三问" }),
      entry(16, "event_msg", { type: "agent_message", message: "第三答" }),
      "",
    ].join("\n"),
    "utf8",
  );
  const updated = importCliLineage(sid);
  check("追加后更新", updated.status, "updated");
  check("追加后 3 轮", updated.turns, 3);
  const third = db
    .prepare(
      "SELECT parent_id, codex_session_id, codex_turn_ordinal FROM nodes WHERE id = ?",
    )
    .get(turn3) as Record<string, unknown>;
  check("第三轮接在第二轮", third.parent_id, turn2);
  check("第三轮沿用 lineage", third.codex_session_id, sid);
  check("第三轮 ordinal", third.codex_turn_ordinal, 3);

  console.log("\n── branch prefix");
  const prefix = buildCodexPrefixRollout(rolloutPath, 1)!;
  const prefixParsed = parseCodexSessionJsonl(prefix.rolloutPath)!;
  check("prefix 换新 session id", prefixParsed.sessionId, prefix.newSid);
  check("注入 role=user 不影响截断", prefixParsed.turns.length, 1);
  check("prefix 保留目标轮回答", prefixParsed.turns[0].response, "第一答");
  check("prefix 排除后续问题", prefixParsed.turns[0].question, "第一问");

  console.log("\n── external CLI fork discovery");
  const nextDay = path.join(process.env.CODEX_HOME, "sessions", "2026", "08", "19");
  fs.mkdirSync(nextDay, { recursive: true });
  const movedForkPath = path.join(nextDay, path.basename(prefix.rolloutPath));
  fs.renameSync(prefix.rolloutPath, movedForkPath);
  const branchTurn = crypto.randomUUID();
  fs.appendFileSync(
    movedForkPath,
    [
      entry(17, "turn_context", { turn_id: branchTurn }),
      entry(18, "event_msg", { type: "user_message", message: "分叉问题" }),
      entry(19, "event_msg", { type: "agent_message", message: "分叉回答" }),
      "",
    ].join("\n"),
    "utf8",
  );
  const crossDateLineage = discoverLineage(movedForkPath, "codex");
  check("跨日期现有 fork attach 时同组", crossDateLineage.members.length, 2);
  reimport(movedForkPath);
  const forkLineages = db
    .prepare(
      "SELECT cli_session_id, provider_family, fork_point_uuid FROM cli_lineages WHERE trellis_session_id = ? ORDER BY is_root DESC",
    )
    .all(sid) as Record<string, unknown>[];
  check("跨日期 fork 自动登记", forkLineages.length, 2);
  check("fork provider=codex", forkLineages[1].provider_family, "codex");
  check("fork point 是共享祖先", forkLineages[1].fork_point_uuid, turn1);
  const branchNode = db
    .prepare(
      "SELECT parent_id, codex_session_id, codex_turn_ordinal FROM nodes WHERE id = ?",
    )
    .get(branchTurn) as Record<string, unknown>;
  check("fork 节点挂共享祖先", branchNode.parent_id, turn1);
  check("fork 节点归新 sid", branchNode.codex_session_id, prefix.newSid);
  check("fork 内 ordinal 独立计数", branchNode.codex_turn_ordinal, 2);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
