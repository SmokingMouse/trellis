import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEndpointFile, readHookToken } from "./endpoint";
import { installHookEndpoint } from "./install";

let dir: string;
const savedEnv = {
  hookDir: process.env.TRELLIS_HOOK_DIR,
  hooks: process.env.TRELLIS_HOOKS,
  port: process.env.TRELLIS_PORT,
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "trellis-hook-install-"));
  process.env.TRELLIS_HOOK_DIR = dir;
  process.env.TRELLIS_PORT = "3199";
  delete process.env.TRELLIS_HOOKS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["TRELLIS_HOOK_DIR", savedEnv.hookDir],
    ["TRELLIS_HOOKS", savedEnv.hooks],
    ["TRELLIS_PORT", savedEnv.port],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("端点文件", () => {
  test("写出端口与随机 token，权限 0600", () => {
    const r = installHookEndpoint();
    expect(r.installed).toBe(true);
    expect(r.port).toBe(3199);

    const env = readEndpointFile();
    expect(env.TRELLIS_HOOK_PORT).toBe("3199");
    expect(env.TRELLIS_HOOK_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(r.endpoint!).mode & 0o777).toBe(0o600);
  });

  test("token 首次生成后复用，端口跟着当次启动更新", () => {
    installHookEndpoint();
    const first = readHookToken();
    expect(first).toBeTruthy();

    process.env.TRELLIS_PORT = "4000";
    installHookEndpoint();
    // 换 token 会让所有已经在跑的 claude 里的 hook 集体 401
    expect(readHookToken()).toBe(first);
    expect(readEndpointFile().TRELLIS_HOOK_PORT).toBe("4000");
  });

  test("把 hook 脚本复制进来并 chmod +x", () => {
    const r = installHookEndpoint();
    const script = path.join(dir, "trellis-hook.sh");
    expect(existsSync(script)).toBe(true);
    expect(r.script).toBe(script);
    expect(statSync(script).mode & 0o111).toBeGreaterThan(0);
    // 内容与仓库里那份一致
    expect(readFileSync(script, "utf8")).toBe(
      readFileSync(path.join(process.cwd(), "scripts/hooks/trellis-hook.sh"), "utf8"),
    );
  });

  test("TRELLIS_HOOKS=off 时不写不装", () => {
    process.env.TRELLIS_HOOKS = "off";
    const r = installHookEndpoint();
    expect(r.installed).toBe(false);
    expect(r.reason).toBe("TRELLIS_HOOKS=off");
    expect(existsSync(path.join(dir, "endpoint.env"))).toBe(false);
    expect(existsSync(path.join(dir, "trellis-hook.sh"))).toBe(false);
  });

  test("目录不存在时自建；写不成也只是返回 installed=false，不抛", () => {
    const nested = path.join(dir, "a", "b", "hooks");
    process.env.TRELLIS_HOOK_DIR = nested;
    expect(installHookEndpoint().installed).toBe(true);
    expect(existsSync(path.join(nested, "endpoint.env"))).toBe(true);

    // 拿一个「是文件不是目录」的路径当 hooks 目录 → mkdir 必失败
    process.env.TRELLIS_HOOK_DIR = path.join(nested, "endpoint.env", "x");
    const bad = installHookEndpoint();
    expect(bad.installed).toBe(false);
    expect(bad.reason).toBeTruthy();
  });

  test("endpoint.env 的解析容得下注释、空行和引号", () => {
    installHookEndpoint();
    const file = path.join(dir, "endpoint.env");
    writeFileSync(file, '# 注释\n\nTRELLIS_HOOK_PORT="5000"\nTRELLIS_HOOK_TOKEN=\'abc\'\n');
    const env = readEndpointFile();
    expect(env.TRELLIS_HOOK_PORT).toBe("5000");
    expect(env.TRELLIS_HOOK_TOKEN).toBe("abc");
  });
});
