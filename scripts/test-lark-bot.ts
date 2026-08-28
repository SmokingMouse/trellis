import { Database } from "bun:sqlite";
import {
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
equal(notMentioned, { kind: "ignore", messageId: "om_1", reason: "not_mentioned" }, "群聊未 @bot 时忽略");

const mentioned = parseIncomingEvent(event({
  message: {
    ...event().message!,
    chat_type: "group",
    content: JSON.stringify({ text: "@_user_1 帮我总结" }),
    mentions: [{ key: "@_user_1", name: "助手", id: { open_id: "ou_bot" } }],
  },
}), "ou_bot");
ok(mentioned.kind === "message" && mentioned.text === "帮我总结", "群 @bot 触发并剥离可信 mention token");

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

console.log(`PASS ${passed} lark assertions`);
