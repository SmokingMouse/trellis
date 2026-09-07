import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Bun's file: install symlinks each file. Turbopack cannot parse a symlinked
// package.json ("a redirect can't be parsed as json"). Materialize only that
// installed manifest, leaving both the source checkout and its exports intact.
const manifest = join(import.meta.dir, "../node_modules/@smokingmouse/agent-server/package.json");
try {
  if (existsSync(manifest) && lstatSync(manifest).isSymbolicLink()) {
    const content = readFileSync(manifest, "utf8");
    const temporary = `${manifest}.${process.pid}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, manifest);
    console.log("agent-server: materialized installed package.json for Turbopack");
  }
} catch (error) { console.warn("[trellis/as] optional manifest preparation skipped:", (error as Error).message); }
