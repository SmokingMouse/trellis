import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

test("N1 vendor excludes unusable maps and dangling sourceMappingURL references", () => {
  const dist = join(import.meta.dir, "../vendor/agent-server/dist");
  const files = readdirSync(dist, { recursive: true }) as string[];
  expect(files.some(file => file.endsWith(".map"))).toBe(false);
  for (const file of files.filter(file => /\.(js|ts)$/.test(file))) {
    expect(readFileSync(join(dist, file), "utf8")).not.toContain("sourceMappingURL=");
  }
});

test("N2 vendor includes the complete upstream MIT license", () => {
  const license = readFileSync(join(import.meta.dir, "../vendor/agent-server/LICENSE"), "utf8");
  expect(license).toContain("MIT License");
  expect(license).toContain("Permission is hereby granted, free of charge");
  expect(license).toContain("THE SOFTWARE IS PROVIDED");
  expect(license).toContain("Copyright");
});
