import { readFileSync } from "node:fs";
import type { ShadowEvent } from "../../lib/as-shadow";

const [base, threadId, expectedPath] = process.argv.slice(2);
const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 10000);
try {
  const response = await fetch(`${base}/api/as/threads/${encodeURIComponent(threadId)}/stream?sinceSeq=0`, {
    headers: { Cookie: "trellis_auth=as-shadow-token", "Last-Event-ID": String(expected.cursor) }, signal: abort.signal,
  });
  if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", found = false;
  while (!found) {
    const part = await reader.read();
    if (part.done) throw new Error("SSE ended before snapshot");
    buffer += decoder.decode(part.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = frame.split("\n").find(line => line.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as ShadowEvent;
      if (event.type !== "snapshot") continue;
      if (event.snapshot.items.length || event.snapshot.nextSeq - 1 !== expected.cursor) throw new Error("Last-Event-ID did not override URL cursor");
      console.log(JSON.stringify({ status: response.status, lastEventId: expected.cursor, urlSinceSeq: 0, snapshotItems: 0, nextSeq: event.snapshot.nextSeq }));
      found = true;
    }
  }
  await reader.cancel();
} finally { clearTimeout(timeout); abort.abort(); }
