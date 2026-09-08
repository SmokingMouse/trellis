import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("hook script uses the real Herdr pane id unless explicitly overridden", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-hook-wire-"));
  const received: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const form = await req.formData();
    received.push(String(form.get("paneKey")));
    expect(JSON.parse(String(form.get("payload"))).session_id).toBe("wire-test");
    return Response.json({ ok: true });
  } });
  try {
    const endpoint = path.join(dir, "endpoint.env");
    fs.writeFileSync(endpoint, `TRELLIS_HOOK_PORT=${server.port}\nTRELLIS_HOOK_TOKEN=local-test\n`);
    for (const [override, herdr, expected] of [["", "w1:p1", "w1:p1"], ["custom", "w1:p1", "custom"], ["", "", ""]]) {
      const child = Bun.spawn(["sh", path.join(import.meta.dir, "trellis-hook.sh")], {
        env: { ...process.env, TRELLIS_HOOK_ENDPOINT: endpoint, TRELLIS_PANE_KEY: override, HERDR_PANE_ID: herdr },
        stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart", session_id: "wire-test" })]), stdout: "ignore", stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      expect(received.at(-1)).toBe(expected);
    }
    expect(received).toHaveLength(3);
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
