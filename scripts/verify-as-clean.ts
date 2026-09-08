import { lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Never delete a pre-existing /tmp/as-clean-verify or somebody else's clone.
const root = resolve(import.meta.dir, "..");
const clone = mkdtempSync("/tmp/as-clean-verify-");
const out = process.env.AS_VERIFY_OUT || join(root, "out/as-clean-verify");
mkdirSync(out, { recursive: true });
let status = 0;
try {
  for (const [name, cmd, cwd] of [
    ["clone", ["git", "clone", "-q", root, clone], root],
    ["install", ["bun", "install", "--ignore-scripts"], clone],
    ["build", ["bun", "run", "build"], clone],
  ] as const) {
    const result = Bun.spawnSync([...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(out, `clean-${name}.log`), Buffer.concat([result.stdout, result.stderr]));
    console.log(`${cmd.join(" ")} (cwd=${cwd}) = ${result.exitCode}`);
    if (result.exitCode !== 0) { status = result.exitCode; break; }
    if (name === "install") {
      const symlink = lstatSync(join(clone, "node_modules/@smokingmouse/agent-server/package.json")).isSymbolicLink();
      console.log(`installed vendor manifest isSymbolicLink=${symlink}; no lifecycle repair`);
      if (symlink) throw new Error("vendor manifest unexpectedly linked");
    }
  }
} finally { rmSync(clone, { recursive: true, force: true }); }
process.exit(status);
