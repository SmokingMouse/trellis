import { expect, test } from "bun:test";
import { GET as list } from "../app/api/as/threads/route";
import { GET as stream } from "../app/api/as/threads/[id]/stream/route";
import { isShadowEnabled } from "./as-config";

test("P1-2 default-off API requests do not create an observer", async () => {
  const enabled = process.env.TRELLIS_AS, socket = process.env.TRELLIS_AS_SOCKET;
  delete process.env.TRELLIS_AS; delete process.env.TRELLIS_AS_SOCKET;
  const globals = globalThis as typeof globalThis & { trellisShadow?: unknown };
  const before = globals.trellisShadow;
  try {
    expect((await list(new Request("http://test/api/as/threads"))).status).toBe(503);
    expect((await stream(new Request("http://test/api/as/threads/t/stream"), { params: Promise.resolve({ id: "t" }) })).status).toBe(503);
    expect(globals.trellisShadow).toBe(before);
  } finally {
    if (enabled === undefined) delete process.env.TRELLIS_AS; else process.env.TRELLIS_AS = enabled;
    if (socket === undefined) delete process.env.TRELLIS_AS_SOCKET; else process.env.TRELLIS_AS_SOCKET = socket;
  }
});

test("N7 explicit off overrides socket and both API routes stay closed", async () => {
  const enabled = process.env.TRELLIS_AS, socket = process.env.TRELLIS_AS_SOCKET;
  const globals = globalThis as typeof globalThis & { trellisShadow?: unknown };
  const before = globals.trellisShadow;
  try {
    process.env.TRELLIS_AS = "off";
    process.env.TRELLIS_AS_SOCKET = "/tmp/unused-as.sock";
    expect(isShadowEnabled()).toBe(false);
    expect((await list(new Request("http://test/api/as/threads"))).status).toBe(503);
    expect((await stream(new Request("http://test/api/as/threads/t/stream"), { params: Promise.resolve({ id: "t" }) })).status).toBe(503);
    expect(globals.trellisShadow).toBe(before);
  } finally {
    if (enabled === undefined) delete process.env.TRELLIS_AS; else process.env.TRELLIS_AS = enabled;
    if (socket === undefined) delete process.env.TRELLIS_AS_SOCKET; else process.env.TRELLIS_AS_SOCKET = socket;
  }
});

test("N6 deployment docs and env example cover all shadow settings with a disabled default", async () => {
  const example = await Bun.file(new URL("../.env.example", import.meta.url)).text();
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  for (const key of ["TRELLIS_AS", "TRELLIS_AS_SOCKET", "TRELLIS_AS_TOKEN_PATH"]) {
    expect(example).toContain(key + "=");
    expect(readme).toContain("`" + key + "`");
  }
  expect(isShadowEnabled({ TRELLIS_AS: example.match(/^TRELLIS_AS=(.*)$/m)![1] })).toBe(false);
});
