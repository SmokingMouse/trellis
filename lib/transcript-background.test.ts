import { describe, expect, test } from "bun:test";
import { scanTranscriptBackground } from "./transcript-background";

// 行形状照抄真实 jsonl（2026-10 claude 2.x 交互模式），只留用得上的字段。
const human = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const toolUse = (id: string, name: string, input: unknown) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, content: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content }] } });
const notification = (taskId: string) =>
  JSON.stringify({
    type: "user",
    origin: { kind: "task-notification" },
    message: { role: "user", content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` },
  });

describe("scanTranscriptBackground", () => {
  test("后台 Bash 启动后未回报 → running；回报后清掉，且这一轮是回报唤起的", () => {
    const lines = [
      human("跑一下测试"),
      toolUse("t1", "Bash", { command: "sleep 20", run_in_background: true }),
      toolResult("t1", "Command running in background with ID: bxp4duyzw. Output is being written to: /tmp/x.output."),
    ];
    expect(scanTranscriptBackground(lines)).toEqual({ running: ["bxp4duyzw"], wokeByTask: false });
    const after = [...lines, notification("bxp4duyzw")];
    expect(scanTranscriptBackground(after)).toEqual({ running: [], wokeByTask: true });
    // 人又说话了：不再算回报唤起
    expect(scanTranscriptBackground([...after, human("好的，继续")]).wokeByTask).toBe(false);
  });

  test("异步子 agent 与超时转后台的前台命令都算；TaskStop / KillShell 结束", () => {
    const lines = [
      toolResult("a", "Async agent launched successfully. (internal)\nagentId: a04f9b0ab616c0a74 (internal ID)"),
      toolResult("b", "Command timed out and was moved to the background (ID: bmh4p5wmv). Output is being written to: /tmp/y"),
      toolResult("c", "agentId: aforeground00000 (for resuming)"),
    ];
    expect(scanTranscriptBackground(lines).running.sort()).toEqual(["a04f9b0ab616c0a74", "bmh4p5wmv"]);
    const stopped = [...lines, toolUse("k", "KillShell", { shell_id: "bmh4p5wmv" }), toolUse("s", "TaskStop", { task_id: "a04f9b0ab616c0a74" })];
    expect(scanTranscriptBackground(stopped).running).toEqual([]);
  });

  test("子 agent 自己的对话（sidechain）、半行、系统提示不干扰", () => {
    const side = JSON.stringify({
      type: "user",
      isSidechain: true,
      message: { content: [{ type: "tool_result", content: "Command running in background with ID: bside" }] },
    });
    const lines = ["{\"type\":\"user\",\"mess", side, human("<system-reminder>x</system-reminder>"), notification("zzz")];
    expect(scanTranscriptBackground(lines)).toEqual({ running: [], wokeByTask: true });
  });
});
