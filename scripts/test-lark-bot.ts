import { Database } from "bun:sqlite";
import {
  backfillLarkThreadFromOutboxIn,
  claimLarkInboxIn,
  diffLarkConnections,
  markdownToLarkText,
  parseIncomingEvent,
  type LarkMessageEvent,
} from "@/lib/server/lark/protocol";
import { AsyncSemaphore } from "@/lib/server/lark/semaphore";

let passed = 0;

function ok(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed++;
}

function equal<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL: ${label}\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
  }
  passed++;
}

const markdown = "# 标题\n\n- **保留** markdown";
equal(JSON.parse(markdownToLarkText(markdown)), { text: markdown }, "markdown 原样进入飞书 text JSON");
const longText = "甲".repeat(4_500);
const truncated = JSON.parse(markdownToLarkText(longText)) as { text: string };
equal(truncated.text.length, 4_000, "超长文本连同尾注不超过 4000 字符");
ok(truncated.text.endsWith("完整内容见 Trellis 会话）"), "截断文本带 Trellis 尾注");

function event(overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_human" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "你好" }),
    },
    ...overrides,
  };
}

const p2p = parseIncomingEvent(event(), null);
ok(p2p.kind === "message" && p2p.text === "你好", "P2P 无需 bot open_id 即可触发");

const missingOpenId = parseIncomingEvent(event({
  message: { ...event().message!, chat_type: "group" },
}), null);
equal(missingOpenId, { kind: "ignore", messageId: "om_1", reason: "bot_open_id_missing" }, "群聊缺 bot open_id 时 fail-closed");

const notMentioned = parseIncomingEvent(event({
  message: { ...event().message!, chat_type: "group", mentions: [] },
}), "ou_bot");
ok(notMentioned.kind === "message" && notMentioned.mentionedBot === false, "群聊未 @bot：协议层只标 mentionedBot=false，门控在 im/policy");

const mentioned = parseIncomingEvent(event({
  message: {
    ...event().message!,
    chat_type: "group",
    content: JSON.stringify({ text: "@_user_1 帮我总结" }),
    mentions: [{ key: "@_user_1", name: "助手", id: { open_id: "ou_bot" } }],
  },
}), "ou_bot");
ok(mentioned.kind === "message" && mentioned.text === "帮我总结" && mentioned.mentionedBot, "群 @bot 标 mentionedBot 并剥离可信 mention token");

const ownMessage = parseIncomingEvent(event({
  sender: { sender_type: "app", sender_id: { open_id: "ou_bot" } },
}), "ou_bot");
equal(ownMessage, { kind: "ignore", messageId: "om_1", reason: "bot_or_app_sender" }, "bot/app 自身消息无条件忽略");

const image = parseIncomingEvent(event({
  message: { ...event().message!, message_type: "image", content: "{}" },
}), "ou_bot");
ok(image.kind === "message" && image.unsupportedType === "image" && image.text === null, "非文本进入统一提示分支");

const db = new Database(":memory:");
db.exec(`CREATE TABLE lark_inbox (
  message_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, status TEXT NOT NULL,
  node_id TEXT
)`);
ok(claimLarkInboxIn(db, "om_primary", "bot_1"), "首次 INSERT 抢到 inbox 槽");
ok(!claimLarkInboxIn(db, "om_primary", "bot_1"), "PRIMARYKEY 冲突判为重复消息");

const uniqueDb = new Database(":memory:");
uniqueDb.exec(`CREATE TABLE lark_inbox (
  message_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, status TEXT NOT NULL, node_id TEXT
)`);
ok(claimLarkInboxIn(uniqueDb, "om_unique", "bot_1"), "UNIQUE 表首次抢槽成功");
ok(!claimLarkInboxIn(uniqueDb, "om_unique", "bot_1"), "UNIQUE 冲突判为重复消息");

const checkDb = new Database(":memory:");
checkDb.exec(`CREATE TABLE lark_inbox (
  message_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'done'), node_id TEXT
)`);
let checkThrew = false;
try {
  claimLarkInboxIn(checkDb, "om_check", "bot_1");
} catch {
  checkThrew = true;
}
ok(checkThrew, "SQLITE_CONSTRAINT_CHECK 不能伪装成重复消息");

const broken = new Database(":memory:");
let threw = false;
try {
  claimLarkInboxIn(broken, "om_db_error", "bot_1");
} catch {
  threw = true;
}
ok(threw, "非 SQLITE_CONSTRAINT DB 错误必须抛出");

const semaphore = new AsyncSemaphore(2);
let concurrent = 0;
let peak = 0;
let sampledPeak = 0;
const sampler = setInterval(() => {
  sampledPeak = Math.max(sampledPeak, semaphore.activeCount);
}, 0);
await Promise.all(
  Array.from({ length: 300 }, (_, index) => semaphore.run(async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    sampledPeak = Math.max(sampledPeak, semaphore.activeCount);
    // 混合 microtask / timer，持续制造 release→waiter handoff 与新 acquire 竞争。
    if (index % 3 === 0) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, index % 2));
    concurrent--;
  })),
);
clearInterval(sampler);
equal(peak, 2, "信号量压测实际并发不超过 cap");
ok(sampledPeak <= 2 && semaphore.activeCount === 0, "信号量内部计数始终不超过 cap 且最终归零");

equal(
  diffLarkConnections(
    [{ id: "keep", fingerprint: "a" }, { id: "new", fingerprint: "b" }, { id: "changed", fingerprint: "v2" }],
    [{ id: "keep", fingerprint: "a" }, { id: "old", fingerprint: "c" }, { id: "changed", fingerprint: "v1" }],
  ),
  { connect: ["changed", "new"], disconnect: ["changed", "old"] },
  "对账 diff 能识别新增、移除和凭证变更",
);

// 测试 Agent 删除时级联解绑 lark_bots 与 tasks
const agentDb = new Database(":memory:");
agentDb.exec(`
  CREATE TABLE agents (id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, builtin INTEGER DEFAULT 0);
  CREATE TABLE lark_bots (id TEXT PRIMARY KEY, name TEXT, app_id TEXT UNIQUE, app_secret TEXT, agent_id TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT, agent_id TEXT);
`);
agentDb.exec(`
  INSERT INTO agents (id, slug, name, builtin) VALUES ('ag_1', 'scout', 'Scout', 0);
  INSERT INTO lark_bots (id, name, app_id, app_secret, agent_id) VALUES ('bot_1', 'Feishu Bot', 'cli_1', 'sec_1', 'ag_1');
  INSERT INTO tasks (id, name, agent_id) VALUES ('task_1', 'Daily Scout', 'ag_1');
`);
const beforeBot = agentDb.prepare("SELECT agent_id FROM lark_bots WHERE id = 'bot_1'").get() as { agent_id: string };
equal(beforeBot.agent_id, "ag_1", "初始状态机器人正确绑定 Agent");

// 模拟 deleteAgent 的解绑 SQL 逻辑
agentDb.prepare("UPDATE lark_bots SET agent_id = NULL WHERE agent_id = ?").run("ag_1");
agentDb.prepare("UPDATE tasks SET agent_id = NULL WHERE agent_id = ?").run("ag_1");
agentDb.prepare("DELETE FROM agents WHERE id = ?").run("ag_1");

const afterBot = agentDb.prepare("SELECT agent_id FROM lark_bots WHERE id = 'bot_1'").get() as { agent_id: string | null };
const afterTask = agentDb.prepare("SELECT agent_id FROM tasks WHERE id = 'task_1'").get() as { agent_id: string | null };
equal(afterBot.agent_id, null, "删除 Agent 后关联的飞书机器人自动解绑（agent_id=null）");
equal(afterTask.agent_id, null, "删除 Agent 后关联的任务自动解绑（agent_id=null）");

// 测试本地凭证发现 (discoverLocalLarkCredentials)
import { discoverLocalLarkCredentials } from "@/lib/server/lark/discover";
const discovered = discoverLocalLarkCredentials();
ok(Array.isArray(discovered), "本地凭证扫描返回数组");
if (discovered.length > 0) {
  const first = discovered[0];
  ok(first.appId.startsWith("cli_"), "扫描到的 App ID 具备 cli_ 前缀");
  ok(first.appSecret.length > 0, "扫描到的 App Secret 非空");
  ok(typeof first.source === "string" && first.source.length > 0, "扫描结果包含来源路径");
}

// ── S134 IM 入口层：策略纯函数 + 协议 thread 字段 + 话题/出站映射 ──
import {
  extractAgentSlug,
  resolveAddress,
  resolveTarget,
  type ImInbound,
  type ImLookups,
} from "@/lib/server/im/policy";
import { LARK_POLICY_DEFAULTS } from "@/lib/lark-types";
import {
  LARK_THREAD_TABLES_SQL,
  larkThreadTailIn,
  nodeOfLarkMessageIn,
  recordLarkOutboxIn,
  upsertLarkThreadIn,
} from "@/lib/server/lark/protocol";
import { pushTaskRunToLark, taskLarkMarkdown } from "@/lib/server/lark/push";
import {
  LarkTaskBindingError,
  resolveLarkTaskBinding,
} from "@/lib/server/lark/task-target";

const P = LARK_POLICY_DEFAULTS;
const noLookups: ImLookups = { nodeOfMessage: () => null, threadTail: () => null, chatTail: () => null };
const inbound = (o: Partial<ImInbound> = {}): ImInbound => ({
  chatType: "group", text: "问题", mentionedBot: false, threadId: null, rootId: null, parentId: null, ...o,
});
const threadLookups: ImLookups = { ...noLookups, threadTail: (t) => (t === "omt_1" ? "node_tail" : null) };
const quoteLookups: ImLookups = { ...noLookups, nodeOfMessage: (m) => (m === "om_bot_reply" ? "node_reply" : null) };

// addressed
equal(resolveAddress(inbound({ chatType: "p2p" }), P, noLookups).reason, "p2p", "私聊恒 addressed");
equal(resolveAddress(inbound(), P, noLookups).addressed, false, "群里未 @ 且非延续 → 不理");
equal(resolveAddress(inbound({ mentionedBot: true }), P, noLookups).reason, "mention", "群 @ → mention");
equal(resolveAddress(inbound(), { ...P, groupTrigger: "all" }, noLookups).reason, "all", "all 档群消息全收");
const prefixed = resolveAddress(inbound({ text: "/ask 帮我看" }), { ...P, groupTrigger: "prefix", triggerPrefix: "/ask" }, noLookups);
ok(prefixed.addressed && prefixed.reason === "prefix" && prefixed.text === "帮我看", "prefix 档命中前缀并剥掉");
equal(resolveAddress(inbound({ text: "闲聊" }), { ...P, groupTrigger: "prefix", triggerPrefix: "/ask" }, noLookups).addressed, false, "prefix 档不带前缀不理");
equal(resolveAddress(inbound({ mentionedBot: true }), { ...P, groupTrigger: "prefix", triggerPrefix: "/ask" }, noLookups).reason, "mention", "prefix 档显式 @ 仍算");
equal(resolveAddress(inbound({ threadId: "omt_1" }), P, threadLookups).reason, "thread", "机器人话题内追问不 @ 也算");
equal(resolveAddress(inbound({ parentId: "om_bot_reply", rootId: "om_root" }), P, quoteLookups).reason, "quote", "引用机器人回答不 @ 也算");

// target
equal(resolveTarget(inbound({ mentionedBot: true }), P, noLookups), { kind: "root", via: "thread" }, "群 thread 策略：顶层 @ = 新树");
equal(resolveTarget(inbound({ mentionedBot: true }), { ...P, sessionPolicy: "chat" }, noLookups), { kind: "root", via: "chat" }, "群 chat 策略首条 = 新树");
equal(resolveTarget(inbound({ mentionedBot: true }), { ...P, sessionPolicy: "chat" }, { ...noLookups, chatTail: () => "tail" }), { kind: "branch", parentId: "tail", via: "chain" }, "群 chat 策略接链尾");
equal(resolveTarget(inbound({ chatType: "p2p" }), P, { ...noLookups, chatTail: () => "tail" }), { kind: "branch", parentId: "tail", via: "chain" }, "私聊恒线性，不受 thread 策略影响");
equal(resolveTarget(inbound({ threadId: "omt_1" }), P, threadLookups), { kind: "branch", parentId: "node_tail", via: "thread" }, "话题内追问接话题叶子");
equal(resolveTarget(inbound({ parentId: "om_bot_reply", rootId: "om_root", threadId: "omt_1" }), P, { ...threadLookups, nodeOfMessage: quoteLookups.nodeOfMessage }), { kind: "branch", parentId: "node_reply", via: "quote" }, "话题内引用具体回答 → 该节点下分支，优先于叶子");
equal(resolveTarget(inbound({ parentId: "om_root", rootId: "om_root", threadId: "omt_1" }), P, { ...threadLookups, nodeOfMessage: (m) => (m === "om_root" ? "node_root" : null) }), { kind: "branch", parentId: "node_tail", via: "thread" }, "话题内平铺发言（parent=root）接叶子而非根");
equal(resolveTarget(inbound({ rootId: "om_root", threadId: "omt_unknown" }), P, { ...noLookups, nodeOfMessage: (m) => (m === "om_root" ? "node_root" : null) }), { kind: "branch", parentId: "node_root", via: "thread" }, "话题未登记但根消息已知 → 接根节点");

// @slug 外援
const known = (s: string) => s === "reviewer";
equal(extractAgentSlug("@reviewer 看看这段", known), { slug: "reviewer", text: "看看这段" }, "@slug 命中已知 agent 并剥离");
equal(extractAgentSlug("问 @someone 一下", known), { slug: null, text: "问 @someone 一下" }, "未知 slug 不吃");
equal(extractAgentSlug("@reviewer", known), { slug: "reviewer", text: "@reviewer" }, "只剩 slug 时保留原文当问题");

// 协议层 thread 字段
const threaded = parseIncomingEvent(event({
  message: { ...event().message!, chat_type: "group", thread_id: "omt_9", root_id: "om_r", parent_id: "om_p", mentions: [] },
}), "ou_bot");
ok(threaded.kind === "message" && !threaded.mentionedBot && threaded.threadId === "omt_9" && threaded.rootId === "om_r" && threaded.parentId === "om_p", "协议层如实归一化 thread/root/parent 与 @ 事实");

// 映射表
const mapDb = new Database(":memory:");
mapDb.exec("CREATE TABLE lark_inbox (message_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, status TEXT NOT NULL, node_id TEXT)");
mapDb.exec(LARK_THREAD_TABLES_SQL);
recordLarkOutboxIn(mapDb, { messageId: "om_out", botId: "b", chatId: "c", nodeId: "n1", threadId: "t1", now: 1 });
equal(nodeOfLarkMessageIn(mapDb, "b", "om_out"), "n1", "出站消息映射到节点");
equal(nodeOfLarkMessageIn(mapDb, "other", "om_out"), null, "别的 bot 查不到");
mapDb.prepare("INSERT INTO lark_inbox (message_id, bot_id, status, node_id) VALUES ('om_in','b','done','n0')").run();
mapDb.prepare("INSERT INTO lark_inbox (message_id, bot_id, status) VALUES ('om_now','b','processing')").run();
equal(nodeOfLarkMessageIn(mapDb, "b", "om_in"), "n0", "用户消息（已落节点）映射到节点");
equal(nodeOfLarkMessageIn(mapDb, "b", "om_now"), null, "处理中尚无节点的消息不算");
upsertLarkThreadIn(mapDb, { botId: "b", chatId: "c", threadId: "t1", sessionId: "s", rootNodeId: "n1", lastNodeId: "n1", now: 1 });
upsertLarkThreadIn(mapDb, { botId: "b", chatId: "c", threadId: "t1", sessionId: "s", rootNodeId: "nX", lastNodeId: "n2", now: 2 });
equal(larkThreadTailIn(mapDb, "b", "t1"), "n2", "话题 upsert 推进叶子");
equal((mapDb.prepare("SELECT root_node_id r FROM lark_threads WHERE thread_id = 't1'").get() as { r: string }).r, "n1", "话题根节点不被后续 upsert 覆盖");
equal(larkThreadTailIn(mapDb, "b", "t9"), null, "未登记话题返回 null");

// ── 定时任务飞书落点：出站登记 / 话题回填 / 引用 / 私聊 / 绑定校验 ──
const pushRows: Array<{ messageId: string; nodeId: string }> = [];
let pushedMode = "";
let privateTail = "";
const pushDeps = {
  enabled: () => true,
  getBot: () => ({ appId: "cli_mock", appSecret: "secret_mock", enabled: true }),
  getChat: (_botId: string, chatId: string) => ({
    id: chatId === "oc_private" ? "chat_private" : "chat_group",
    chatType: chatId === "oc_private" ? "p2p" as const : "group" as const,
  }),
  createClient: () => ({} as never),
  sendText: async (args: { mode: "plain" }) => {
    pushedMode = args.mode;
    return { messageId: "om_task_push", threadId: null };
  },
  recordOutbox: (row: { messageId: string; nodeId: string }) => {
    pushRows.push({ messageId: row.messageId, nodeId: row.nodeId });
  },
  advanceChat: (_chatRowId: string, nodeId: string) => {
    privateTail = nodeId;
  },
};
const pushed = await pushTaskRunToLark({
  botId: "b",
  chatId: "oc_group",
  sessionId: "s_task",
  nodeId: "n_task",
  markdown: "日报 OK",
}, pushDeps);
equal(pushed, { status: "sent", messageId: "om_task_push" }, "任务推送成功返回 message_id");
equal(pushRows, [{ messageId: "om_task_push", nodeId: "n_task" }], "任务推送成功后登记 outbox");
equal(pushedMode, "plain", "群任务推送使用 plain 顶层消息");

await pushTaskRunToLark({
  botId: "b",
  chatId: "oc_private",
  sessionId: "s_task",
  nodeId: "n_private",
  markdown: "私聊 OK",
}, pushDeps);
equal(privateTail, "n_private", "私聊任务落点推进既有 p2p 链尾");

let drySent = false;
const dryResult = await pushTaskRunToLark({
  botId: "b",
  chatId: "oc_group",
  sessionId: "s_task",
  nodeId: "n_dry",
  markdown: "不会真发",
}, {
  ...pushDeps,
  enabled: () => false,
  sendText: async () => {
    drySent = true;
    return { messageId: "impossible", threadId: null };
  },
});
ok(dryResult.status === "skipped" && !drySent, "TRELLIS_LARK=off 只 dry-run 且不调用 client");
const linkedLong = taskLarkMarkdown("甲".repeat(4_500), "/?session=s&node=n");
ok(linkedLong.length <= 4_000 && linkedLong.includes("/?session=s&node=n"), "任务超长正文截断后保留画布深链");

const taskThreadDb = new Database(":memory:");
taskThreadDb.exec(`
  CREATE TABLE lark_inbox (message_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, status TEXT NOT NULL, node_id TEXT);
  CREATE TABLE nodes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT);
`);
taskThreadDb.exec(LARK_THREAD_TABLES_SQL);
taskThreadDb.prepare("INSERT INTO nodes VALUES ('n_task_root','s_lark',NULL)").run();
recordLarkOutboxIn(taskThreadDb, {
  messageId: "om_task_root", botId: "b", chatId: "oc_group", nodeId: "n_task_root", threadId: null, now: 1,
});
const filled = backfillLarkThreadFromOutboxIn(taskThreadDb, {
  botId: "b", chatId: "oc_group", threadId: "omt_task", rootMessageId: "om_task_root", now: 2,
});
equal(filled, { sessionId: "s_lark", rootNodeId: "n_task_root", lastNodeId: "n_task_root" }, "推送消息首次出现 thread_id 时回填话题树");
const taskThreadLookups: ImLookups = {
  nodeOfMessage: (messageId) => nodeOfLarkMessageIn(taskThreadDb, "b", messageId),
  threadTail: (threadId) => larkThreadTailIn(taskThreadDb, "b", threadId),
  chatTail: () => null,
};
const taskFollowup = inbound({ threadId: "omt_task", rootId: "om_task_root" });
equal(resolveAddress(taskFollowup, P, taskThreadLookups), { addressed: true, reason: "thread", text: "问题" }, "任务推送的话题追问无需 @ 也 addressed");
equal(resolveTarget(taskFollowup, P, taskThreadLookups), { kind: "branch", parentId: "n_task_root", via: "thread" }, "任务推送的话题追问接该树叶子");
equal(
  resolveTarget(inbound({ parentId: "om_task_root", rootId: "om_other" }), P, taskThreadLookups),
  { kind: "branch", parentId: "n_task_root", via: "quote" },
  "引用任务推送消息在该节点下分支",
);

let mismatchRejected = false;
try {
  resolveLarkTaskBinding(
    { larkBotId: "bot_a", larkChatId: "chat_of_b" },
    () => "chat_missing",
  );
} catch (error) {
  mismatchRejected = error instanceof LarkTaskBindingError;
}
ok(mismatchRejected, "绑定校验拒绝 bot / chat 不匹配");
let halfRejected = false;
try {
  resolveLarkTaskBinding({ larkBotId: "bot_a" }, () => "ok");
} catch (error) {
  halfRejected = error instanceof LarkTaskBindingError;
}
ok(halfRejected, "绑定校验拒绝只提交 bot 或 chat 一半");

// S134 bundle 守卫：飞书 SDK 与 ws 必须留在 serverExternalPackages。Turbopack 内联的真 ws 在
// Bun 下握手失败（Unexpected server response: 101），且 SDK 不回调 —— 症状是「已保存、无错误、
// 就是没反应」，靠这条断言挡住回归。
import fs from "node:fs";
import path from "node:path";
const nextConfigText = fs.readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
const externalsBlock = nextConfigText.match(/serverExternalPackages:\s*\[([^\]]*)\]/)?.[1] ?? "";
ok(externalsBlock.includes("\"@larksuiteoapi/node-sdk\""), "next.config serverExternalPackages 含 @larksuiteoapi/node-sdk（Bun 下 ws 握手守卫）");
ok(externalsBlock.includes("\"ws\""), "next.config serverExternalPackages 含 ws（Bun 按名替换原生 WebSocket）");

console.log(`PASS ${passed} lark assertions`);
