// Dump all events to understand what Codex actually emits
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  skipGitRepoCheck: true,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchEnabled: false,
});

const question = "用一段话解释 Rust 的 ownership 系统在汇编层面是怎么实现的？需要 runtime 开销吗？";
console.log("Q:", question, "\n---");

const result = await thread.runStreamed(question);
for await (const event of result.events) {
  if (event.type === "item.updated" || event.type === "item.completed" || event.type === "item.started") {
    const item = event.item;
    const preview = "text" in item
      ? item.text.slice(0, 80).replace(/\n/g, "\\n")
      : JSON.stringify(item).slice(0, 80);
    console.log(`[${event.type}] item.type=${item.type} preview="${preview}"`);
  } else {
    console.log(`[${event.type}]`, JSON.stringify(event).slice(0, 200));
  }
}
