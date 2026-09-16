import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { installTtyd, TTYD_ARCH_ASSETS, TTYD_RELEASE_VERSION } = await import(
  "./ttyd-install"
);
type FetchLike = (
  input: RequestInfo | URL | string,
  init?: RequestInit & { proxy?: string; dispatcher?: unknown },
) => Promise<Response>;

const { POST: installRoutePost } = await import(
  "../../app/api/terminals/install/route"
);

describe("lib/server/ttyd-install", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `trellis-ttyd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理错误 */
    }
  });

  describe("平台与架构检查", () => {
    it("非 Linux 系统（如 darwin）拒绝安装并返回提示", async () => {
      const result = await installTtyd({
        platform: "darwin",
        targetDir: testDir,
        fetchFn: async () => {
          throw new Error("不得访问网络");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toContain("自动安装仅支持 Linux 系统");
    });

    it("不支持的 arch（如 riscv64）报错并拒绝安装", async () => {
      const result = await installTtyd({
        platform: "linux",
        arch: "riscv64",
        targetDir: testDir,
        fetchFn: async () => {
          throw new Error("不得访问网络");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toContain("不支持的 CPU 架构: riscv64");
    });
  });

  describe("release 资产 arch 映射", () => {
    it("x64 映射到 ttyd.x86_64 资产 URL", async () => {
      let requestedUrl = "";
      const dummyContent = "#!/bin/sh\nexit 0\n";
      const dummySha = crypto.createHash("sha256").update(Buffer.from(dummyContent)).digest("hex");

      const mockFetch: FetchLike = async (url: RequestInfo | URL | string) => {
        requestedUrl = String(url);
        return new Response(dummyContent, { status: 200 });
      };

      await installTtyd({
        platform: "linux",
        arch: "x64",
        targetDir: testDir,
        fetchFn: mockFetch,
        expectedSha256: dummySha,
      });

      expect(requestedUrl).toBe(
        `https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/ttyd.x86_64`,
      );
    });

    it("arm64 映射到 ttyd.aarch64 资产 URL", async () => {
      let requestedUrl = "";
      const dummyContent = "#!/bin/sh\nexit 0\n";
      const dummySha = crypto.createHash("sha256").update(Buffer.from(dummyContent)).digest("hex");

      const mockFetch: FetchLike = async (url: RequestInfo | URL | string) => {
        requestedUrl = String(url);
        return new Response(dummyContent, { status: 200 });
      };

      await installTtyd({
        platform: "linux",
        arch: "arm64",
        targetDir: testDir,
        fetchFn: mockFetch,
        expectedSha256: dummySha,
      });

      expect(requestedUrl).toBe(
        `https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/ttyd.aarch64`,
      );
    });
  });

  describe("SHA256 校验与文件原子操作", () => {
    it("sha256 不符时删除临时文件且目标文件不存在，不留半截文件", async () => {
      const corruptedContent = "corrupted-content";
      const mockFetch: FetchLike = async () => {
        return new Response(corruptedContent, { status: 200 });
      };

      const result = await installTtyd({
        platform: "linux",
        arch: "x64",
        targetDir: testDir,
        fetchFn: mockFetch,
        expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      });

      expect(result.ok).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toContain("SHA256 校验失败");

      // 目标文件不得存在
      const targetFile = path.join(testDir, "ttyd");
      expect(fs.existsSync(targetFile)).toBe(false);

      // 临时文件也不得残留
      const remainingFiles = fs.readdirSync(testDir);
      expect(remainingFiles).toEqual([]);
    });

    it("成功时文件可执行且返回路径", async () => {
      // 构造一个合法的可执行脚本桩（模拟 ttyd）
      const scriptContent = "#!/bin/sh\necho \"ttyd version 1.7.7\"\nexit 0\n";
      const buffer = Buffer.from(scriptContent);
      const sha = crypto.createHash("sha256").update(buffer).digest("hex");

      const mockFetch: FetchLike = async () => {
        return new Response(buffer, { status: 200 });
      };

      const result = await installTtyd({
        platform: "linux",
        arch: "x64",
        targetDir: testDir,
        fetchFn: mockFetch,
        expectedSha256: sha,
      });

      expect(result.ok).toBe(true);
      const targetFile = path.join(testDir, "ttyd");
      expect(result.path).toBe(targetFile);
      expect(fs.existsSync(targetFile)).toBe(true);

      // 检查文件是否有可执行权限 (0o755)
      const stat = fs.statSync(targetFile);
      const isExecutable = (stat.mode & 0o111) !== 0;
      expect(isExecutable).toBe(true);

      // 检查没有残留临时文件
      const remainingFiles = fs.readdirSync(testDir);
      expect(remainingFiles).toEqual(["ttyd"]);
    });
  });

  describe("内置 1.7.7 release 资产配置", () => {
    it("包含 x64 和 arm64 且 sha256 格式为 64 位十六进制", () => {
      expect(TTYD_ARCH_ASSETS.x64.asset).toBe("ttyd.x86_64");
      expect(TTYD_ARCH_ASSETS.x64.sha256).toMatch(/^[a-f0-9]{64}$/);

      expect(TTYD_ARCH_ASSETS.arm64.asset).toBe("ttyd.aarch64");
      expect(TTYD_ARCH_ASSETS.arm64.sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("API 路由 app/api/terminals/install", () => {
    it("POST 路由并发第二次调用返回 409，格式符合 { ok, path, tried, error }", async () => {
      const origPlatform = process.platform;
      const origFetch = globalThis.fetch;
      try {
        Object.defineProperty(process, "platform", {
          value: "linux",
          configurable: true,
        });

        let resolveFetch: ((res: Response) => void) | null = null;
        globalThis.fetch = (() =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })) as unknown as typeof fetch;

        const req1Promise = installRoutePost();
        // 微任务等待，确保 req1 已将 installing 置为 true 并卡在 fetch
        await new Promise((r) => setTimeout(r, 10));

        const req2Response = await installRoutePost();
        expect(req2Response.status).toBe(409);
        const req2Data = (await req2Response.json()) as Record<string, unknown>;
        expect(req2Data.ok).toBe(false);
        expect(req2Data.error).toContain("已有安装任务正在进行中");
        expect("path" in req2Data).toBe(true);
        expect("tried" in req2Data).toBe(true);
        expect("error" in req2Data).toBe(true);

        // 放行 req1
        if (resolveFetch) {
          (resolveFetch as (res: Response) => void)(
            new Response("error", { status: 500, statusText: "Internal Error" }),
          );
        }
        const req1Response = await req1Promise;
        const req1Data = (await req1Response.json()) as Record<string, unknown>;
        expect("ok" in req1Data).toBe(true);
        expect("path" in req1Data).toBe(true);
        expect("tried" in req1Data).toBe(true);
        expect("error" in req1Data).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", {
          value: origPlatform,
          configurable: true,
        });
        globalThis.fetch = origFetch;
      }
    });
  });
});
