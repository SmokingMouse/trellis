// Claude Code transcript（jsonl）里的后台任务：「这一轮结束时还有没有活在跑」「这一轮是不是
// 后台任务回报唤起的」。纯函数，输入是 jsonl 的行，给「已完成」推送的延迟裁决用
// （lib/push-done.ts）。
//
// 实测形状（2026-10，claude 2.x 交互模式）：
//   - 后台 Bash（run_in_background）的 tool_result 立刻回
//     "Command running in background with ID: <id>. Output is being written to: …"；
//     前台慢命令超时转后台回 "… moved to the background (ID: <id>)"；
//     异步子 agent 回 "Async agent launched … agentId: <id>"。
//   - 任务结束时 CLI 往对话里塞一条 user 消息（origin.kind = "task-notification"），
//     正文是 <task-notification><task-id><id></task-id>…<status>completed</status>…；
//     TaskStop / KillShell 主动杀掉的也算结束。
//   - `claude -p` 一轮结束会直接杀掉后台任务（task_updated status=killed），所以这套只对
//     常驻的交互会话（Herdr 窗格）有意义。

const BG_STARTED = [
  /running in background with ID:\s*([A-Za-z0-9_-]+)/,
  /moved to the background \(ID:\s*([A-Za-z0-9_-]+)\)/,
];
const ASYNC_AGENT = /Async agent launched[\s\S]*?agentId:\s*([A-Za-z0-9_-]+)/;
const NOTIFIED = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>/g;
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);

export type TranscriptBackground = {
  /** 启动了、还没回报 / 没被杀的后台任务 id。 */
  running: string[];
  /** 最后一条「人那边来的」消息是后台任务回报（不是人敲的）。 */
  wokeByTask: boolean;
};

type Block = { type?: string; text?: unknown; content?: unknown; name?: unknown; input?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: Block) => (typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : textOf(b?.content)))
    .join("\n");
}

export function scanTranscriptBackground(lines: Iterable<string>): TranscriptBackground {
  const running = new Map<string, true>();
  let wokeByTask = false;
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let row: { type?: string; isSidechain?: boolean; origin?: { kind?: string }; message?: { role?: string; content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue; // 尾扫切在半行上
    }
    // 子 agent 自己的对话不算（它的后台任务由它自己收尾）。
    if (row.isSidechain) continue;
    const content = row.message?.content;
    if (row.type === "assistant" && Array.isArray(content)) {
      for (const b of content as Block[]) {
        if (b?.type !== "tool_use" || typeof b.name !== "string" || !STOP_TOOLS.has(b.name)) continue;
        const input = (b.input ?? {}) as { task_id?: unknown; shell_id?: unknown; bash_id?: unknown };
        for (const id of [input.task_id, input.shell_id, input.bash_id]) if (typeof id === "string") running.delete(id);
      }
      continue;
    }
    if (row.type !== "user") continue;
    const blocks = Array.isArray(content) ? (content as Block[]) : [];
    const isToolResult = blocks.length > 0 && blocks.every((b) => b?.type === "tool_result");
    if (isToolResult) {
      for (const b of blocks) {
        const text = textOf(b.content);
        for (const re of BG_STARTED) {
          const m = text.match(re);
          if (m) running.set(m[1], true);
        }
        const agent = text.match(ASYNC_AGENT);
        if (agent) running.set(agent[1], true);
      }
      continue;
    }
    // 人那边来的一条：人敲的，或 CLI 塞进来的任务回报。
    const text = textOf(content);
    const notification = row.origin?.kind === "task-notification" || text.trimStart().startsWith("<task-notification>");
    if (notification) for (const m of text.matchAll(NOTIFIED)) running.delete(m[1]);
    // 系统提示 / 命令回显之类的 meta 消息不改「谁唤起的」判断；真人消息才清零。
    if (notification) wokeByTask = true;
    else if (text.trim() && !text.trimStart().startsWith("<")) wokeByTask = false;
  }
  return { running: [...running.keys()], wokeByTask };
}
