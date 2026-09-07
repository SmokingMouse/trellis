import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("P1-1/P2-5 preparation tolerates missing dependency and repairs only installed symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "as-prepare-test-"));
  try {
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts/prepare-as-dependency.ts");
    cpSync(join(import.meta.dir, "prepare-as-dependency.ts"), script);
    const missing = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    expect(await missing.exited).toBe(0);
    expect(await new Response(missing.stderr).text()).toBe("");
    const installed = join(root, "node_modules/@smokingmouse/agent-server");
    mkdirSync(installed, { recursive: true });
    const original = join(import.meta.dir, "../vendor/agent-server/package.json");
    symlinkSync(original, join(installed, "package.json"));
    const before = readFileSync(original, "utf8");
    const repair = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    expect(await repair.exited).toBe(0);
    expect(lstatSync(join(installed, "package.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(original, "utf8")).toBe(before);
    expect(readFileSync(join(installed, "package.json"), "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
