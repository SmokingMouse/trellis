import { describe, expect, test } from "bun:test";
import { formatSseFrame, parseSseFrames } from "./sse-frames";

describe("SSE 多路复用帧", () => {
  test("编码后可原样解析出通道与数据", () => {
    const wire = formatSseFrame("herdr", { type: "changed", fleetEtag: "W/\"a\"" }) + formatSseFrame("cli", { type: "session_updated", sessionId: "s" });
    const { frames, rest } = parseSseFrames(wire);
    expect(rest).toBe("");
    expect(frames.map(f => f.event)).toEqual(["herdr", "cli"]);
    expect(JSON.parse(frames[0].data)).toEqual({ type: "changed", fleetEtag: "W/\"a\"" });
  });

  test("跨 chunk 的半帧留到下一轮", () => {
    const wire = formatSseFrame("task", { type: "run_started", taskId: "t", runId: "r" });
    const cut = 17;
    const first = parseSseFrames(wire.slice(0, cut));
    expect(first.frames).toHaveLength(0);
    const second = parseSseFrames(first.rest + wire.slice(cut));
    expect(second.frames).toEqual([{ event: "task", data: JSON.stringify({ type: "run_started", taskId: "t", runId: "r" }) }]);
  });

  test("注释心跳丢弃；无 event 字段记为 message；多行 data 以换行拼接；CRLF 兼容", () => {
    const { frames } = parseSseFrames(": ping\n\ndata: a\ndata: b\n\r\nevent: cli\r\ndata: {}\r\n\r\n");
    expect(frames).toEqual([{ event: "message", data: "a\nb" }, { event: "cli", data: "{}" }]);
  });
});
