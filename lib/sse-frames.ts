// /api/events 的 SSE 帧格式（服务端编码 + 客户端增量解析，纯函数便于单测）。

export type PageEventChannel = "cli" | "task" | "herdr";

export type SseFrame = { event: string; data: string };

export function formatSseFrame(event: string, data: unknown): string {
  // JSON.stringify 不产生裸换行，一条 data 行足够。
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 增量解析：把累积缓冲切成完整帧，返回帧列表与剩余的半帧。
 * 注释行（`: ping`）和没有 data 的帧丢弃；无 event 字段按 SSE 规范记为 "message"。
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.includes("\r") ? buffer.replace(/\r\n?/g, "\n") : buffer;
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}
