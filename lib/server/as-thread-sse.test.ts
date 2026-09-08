import { expect, test } from "bun:test";
import { createThreadSseBuffer } from "./as-thread-sse";

test("P2-6 >1MB initial replay does not close SSE before its first consumer", async () => {
  let closed = 0;
  const buffer = createThreadSseBuffer(() => closed++);
  const initial = "data: " + "x".repeat(2 * 1024 * 1024) + "\n\n";
  buffer.send(initial, true);
  buffer.send("data: live\n\n");
  buffer.send(": heartbeat\n\n");
  expect(closed).toBe(0);
  const reader = buffer.stream.getReader();
  expect((await reader.read()).value?.byteLength).toBe(initial.length);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: live\n\n");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
  buffer.send("data: still connected\n\n");
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  expect(closed).toBe(1);
});

test("P2-6 live slow-consumer backlog remains bounded after replay exemption", () => {
  let closed = 0;
  const buffer = createThreadSseBuffer(() => closed++);
  buffer.send("snapshot", true);
  buffer.send("x".repeat(1024 * 1024));
  buffer.send("more");
  expect(closed).toBe(1);
  buffer.close();
  expect(closed).toBe(1);
});
