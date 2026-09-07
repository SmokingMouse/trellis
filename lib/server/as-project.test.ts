import { expect, test } from "bun:test";

// Separate processes isolate the repository's singleton DB and daemon env.
for (const name of ["P0-1 retry preserves answers", "P1-1 non-tip continuation", "P1-2 hard off fallback", "P2-2 failed startup cleans bindings", "P2-2 concurrent catchup shares initialization"]) {
  test(name, async () => {
    const child = Bun.spawn([process.execPath, "run", "scripts/mobile-verify/as-project-regression.ts", name], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, details: code ? stdout + stderr : "passed" }).toEqual({ code: 0, details: "passed" });
  }, 30000);
}
