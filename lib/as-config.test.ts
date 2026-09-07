import { expect, test } from "bun:test";
import { GET as list } from "../app/api/as/threads/route";
import { GET as stream } from "../app/api/as/threads/[id]/stream/route";

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
