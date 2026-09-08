import { expect, test } from "bun:test";
import { isAgentServerEnabled, isAdoptEnabled } from "./as-config";

test("deployment docs and env example cover agent-server settings with a disabled default", async () => {
  const example = await Bun.file(new URL("../.env.example", import.meta.url)).text();
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  for (const key of ["TRELLIS_AS", "TRELLIS_AS_SOCKET", "TRELLIS_AS_TOKEN_PATH", "TRELLIS_AS_ADOPT"]) {
    expect(example).toContain(key + "=");
    expect(readme).toContain("`" + key + "`");
  }
  expect(isAgentServerEnabled({ TRELLIS_AS: example.match(/^TRELLIS_AS=(.*)$/m)![1] })).toBe(false);
});

test("hard-off overrides socket and adoption", () => {
  expect(isAgentServerEnabled({ TRELLIS_AS: "off", TRELLIS_AS_SOCKET: "/tmp/as.sock" })).toBe(false);
  expect(isAdoptEnabled({ TRELLIS_AS: "off", TRELLIS_AS_ADOPT: "on" })).toBe(false);
  expect(isAdoptEnabled({ TRELLIS_AS: "on", TRELLIS_AS_PROJECT: "off", TRELLIS_AS_ADOPT: "on" })).toBe(true);
});
