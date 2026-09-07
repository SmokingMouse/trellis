import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("P0-1/P1-1/P2-4/P2-5 vendor is self-contained without workspace overrides or lifecycle repair", () => {
  const root = join(import.meta.dir, "..");
  const project = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const vendor = JSON.parse(readFileSync(join(root, "vendor/agent-server/package.json"), "utf8"));
  expect(project.dependencies["@smokingmouse/agent-server"]).toBe("file:./vendor/agent-server");
  expect(project.overrides).toBeUndefined();
  expect(project.scripts.postinstall).toBeUndefined();
  expect(project.scripts.build).not.toContain("prepare-as-dependency");
  expect(vendor.scripts).toBeUndefined();
  expect(vendor.devDependencies).toBeUndefined();
  expect(vendor.dependencies).toEqual({ "@smokingmouse/agent": "0.8.0", zod: "^4.4.3" });
  for (const target of Object.values(vendor.exports) as { types: string; default: string }[]) {
    expect(existsSync(join(root, "vendor/agent-server", target.types))).toBe(true);
    expect(existsSync(join(root, "vendor/agent-server", target.default))).toBe(true);
  }
});
