import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  encodeConnectionString,
  parseConnectionString,
  readHubNodeFile,
  removeHubNodeFile,
  writeHubNodeFile,
} from "./hub-node-config";

test("连接串往返，且只认 http(s) hub 与合法名字", () => {
  const s = encodeConnectionString({ hub: "https://hub.example.com/", name: "office", ticket: "tp_x" });
  expect(s.startsWith("trellis://v1/")).toBe(true);
  expect(parseConnectionString(`  ${s}\n`)).toEqual({ hub: "https://hub.example.com", name: "office", ticket: "tp_x" });
  expect(parseConnectionString("trellis://v1/not-base64-json")).toBeNull();
  expect(parseConnectionString(encodeConnectionString({ hub: "file:///etc", name: "a", ticket: "t" }))).toBeNull();
  expect(parseConnectionString(encodeConnectionString({ hub: "https://h", name: "Bad Name", ticket: "t" }))).toBeNull();
  expect(parseConnectionString("https://example.com")).toBeNull();
});

test("配置文件写入为 0600、可读回、可删除", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-node-"));
  const file = path.join(dir, "sub", "hub-node.json");
  const cfg = { hubURL: "https://hub", nodeName: "office", nodeToken: "tn_secret" };
  writeHubNodeFile(cfg, file);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(readHubNodeFile(file)).toEqual(cfg);
  expect(removeHubNodeFile(file)).toBe(true);
  expect(readHubNodeFile(file)).toBeNull();
  fs.rmSync(dir, { recursive: true, force: true });
});
