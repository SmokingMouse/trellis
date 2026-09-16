import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  installTtyd,
  TTYD_ARCH_ASSETS,
  TTYD_RELEASE_VERSION,
  MAX_TTYD_DOWNLOAD_BYTES,
} = await import("./ttyd-install");

type FetchLike = (
  input: RequestInfo | URL | string,
  init?: RequestInit & { proxy?: string },
) => Promise<Response>;

const { POST: installRoutePost } = await import(
  "../../app/api/terminals/install/route"
);

describe("lib/server/ttyd-install", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `trellis-ttyd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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

  describe("release 资产 arch 映射 (m6)", () => {
    it("x64 映射到 ttyd.x86_64", async () => {
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

    it("arm64 映射到 ttyd.aarch64", async () => {
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

    it("arm 映射到 ttyd.arm (m6)", async () => {
      let requestedUrl = "";
      const dummyContent = "#!/bin/sh\nexit 0\n";
      const dummySha = crypto.createHash("sha256").update(Buffer.from(dummyContent)).digest("hex");

      const mockFetch: FetchLike = async (url: RequestInfo | URL | string) => {
        requestedUrl = String(url);
        return new Response(dummyContent, { status: 200 });
      };

      await installTtyd({
        platform: "linux",
        arch: "arm",
        targetDir: testDir,
        fetchFn: mockFetch,
        expectedSha256: dummySha,
      });

      expect(requestedUrl).toBe(
        `https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/ttyd.arm`,
      );
    });

    it("ia32 映射到 ttyd.i686 (m6)", async () => {
      let requestedUrl = "";
      const dummyContent = "#!/bin/sh\nexit 0\n";
      const dummySha = crypto.createHash("sha256").update(Buffer.from(dummyContent)).digest("hex");

      const mockFetch: FetchLike = async (url: RequestInfo | URL | string) => {
        requestedUrl = String(url);
        return new Response(dummyContent, { status: 200 });
      };

      await installTtyd({
        platform: "linux",
        arch: "ia32",
        targetDir: testDir,
        fetchFn: mockFetch,
        expectedSha256: dummySha,
      });

      expect(requestedUrl).toBe(
        `https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/ttyd.i686`,
      );
    });
  });

  describe("下载超时与大小上限 (M1)", () => {
    it("挂起的 fetch 桩在超时后返回 ok:false 并提示超时", async () => {
      const hangingFetch: FetchLike = async (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      };

      const result = await installTtyd({
        platform: "linux",
        arch: "x64",
        targetDir: testDir,
        fetchFn: hangingFetch,
        timeoutMs: 50, // 50ms 超时
      });

      expect(result.ok).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toContain("超时");
    });

    it("响应头 Content-Length 超过 20MB 时报错拒绝", async () => {
      const mockFetch: FetchLike = async () => {
        return new Response("dummy", {
          status: 200,
          headers: { "content-length": String(MAX_TTYD_DOWNLOAD_BYTES + 1024) },
        });
      };

      const result = await installTtyd({
        platform: "linux",
        arch: "x64",
        targetDir: testDir,
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("超过限制");
    });

    it("实际流式传输体超过 20MB 时报错拒绝", async () => {
      const mockFetch: FetchLike = async () => {
        // 创建超过 20MB 的流
        const chunk = new Uint8Array(5 * 1024 * 1024);
        let sent = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent < 25 * 1024 * 1024) {
              controller.enqueue(chunk);
              sent += chunk.length;
            } else {
              controller.close();
            }
          },
        });
        return new Response(stream, { status: 200 });
      };

      const result = await installTtyd({
        platform: "linux",
        arch: "x64",
        targetDir: testDir,
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("超出限制");
    });
  });

  describe("临时文件清理保证 (M2)", () => {
    it("writeFileSync 抛出 ENOSPC 时临时文件在 finally 中被删除，目录无 .ttyd.tmp.* 残留", async () => {
      const origWriteFileSync = fs.writeFileSync;
      try {
        // 模拟磁盘已满抛错 ENOSPC，但在抛错前创建了半截文件
        fs.writeFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
          origWriteFileSync(filePath, "half-written");
          const err = new Error("ENOSPC: no space left on device, write");
          (err as NodeJS.ErrnoException).code = "ENOSPC";
          throw err;
        }) as typeof fs.writeFileSync;

        const dummyContent = "#!/bin/sh\nexit 0\n";
        const dummySha = crypto.createHash("sha256").update(Buffer.from(dummyContent)).digest("hex");
        const mockFetch: FetchLike = async () => {
          return new Response(dummyContent, { status: 200 });
        };

        const result = await installTtyd({
          platform: "linux",
          arch: "x64",
          targetDir: testDir,
          fetchFn: mockFetch,
          expectedSha256: dummySha,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain("ENOSPC");

        // 验证目录中没有残余的 .ttyd.tmp.* 临时文件
        const files = fs.readdirSync(testDir);
        expect(files.filter((f) => f.includes(".ttyd.tmp"))).toEqual([]);
      } finally {
        fs.writeFileSync = origWriteFileSync;
      }
    });

    it("sha256 不符时删除临时文件且目标文件不存在", async () => {
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

      const targetFile = path.join(testDir, "ttyd");
      expect(fs.existsSync(targetFile)).toBe(false);
      expect(fs.readdirSync(testDir)).toEqual([]);
    });
  });

  describe("复探独立验证 targetPath (M3)", () => {
    it("targetPath 探测失败 + 系统另有可用 ttyd 时返回 ok:false，绝不冒充成功", async () => {
      // 写入一个无法执行的二进制桩（例如执行时 exit code 错误或格式无效）
      const invalidScript = "not-an-executable-format\0\0\0";
      const buffer = Buffer.from(invalidScript);
      const sha = crypto.createHash("sha256").update(buffer).digest("hex");

      const mockFetch: FetchLike = async () => {
        return new Response(buffer, { status: 200 });
      };

      // 无论系统 PATH 或全局是否存在 ttyd，installTtyd 必须单独先验 targetPath
      const result = await installTtyd({
        platform: "linux",
        arch: "x64",
        targetDir: testDir,
        fetchFn: mockFetch,
        expectedSha256: sha,
      });

      expect(result.ok).toBe(false);
      expect(result.path).toBeNull();
      expect(result.error).toContain(`已下载到 ${path.join(testDir, "ttyd")} 但无法执行`);
    });

    it("成功时文件可执行且返回路径", async () => {
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

      const stat = fs.statSync(targetFile);
      expect((stat.mode & 0o111) !== 0).toBe(true);
      expect(fs.readdirSync(testDir)).toEqual(["ttyd"]);
    });
  });

  describe("内置 1.7.7 release 资产配置 (m6)", () => {
    it("包含 x64, arm64, arm, ia32 且 sha256 格式为 64 位十六进制", () => {
      const archs = ["x64", "arm64", "arm", "ia32"];
      for (const a of archs) {
        expect(TTYD_ARCH_ASSETS[a]).toBeDefined();
        expect(TTYD_ARCH_ASSETS[a].sha256).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(TTYD_ARCH_ASSETS.arm.asset).toBe("ttyd.arm");
      expect(TTYD_ARCH_ASSETS.ia32.asset).toBe("ttyd.i686");
    });
  });

  describe("API 路由并发闸与错误状态码 (M1 / m7)", () => {
    it("安装超时后闸自动释放，再次调用不再 409 (M1)；失败返回 500 (m7)", async () => {
      const origPlatform = process.platform;
      const origFetch = globalThis.fetch;
      try {
        Object.defineProperty(process, "platform", {
          value: "linux",
          configurable: true,
        });

        // 第一次请求让 fetch 挂起
        let abortCallback: (() => void) | null = null;
        globalThis.fetch = ((_url: string, init?: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            if (init?.signal) {
              abortCallback = () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              };
              init.signal.addEventListener("abort", abortCallback);
            }
          });
        }) as unknown as typeof fetch;

        const req1Promise = installRoutePost();
        await new Promise((r) => setTimeout(r, 10));

        // 第二次并发请求立即返回 409
        const req2Response = await installRoutePost();
        expect(req2Response.status).toBe(409);
        const req2Data = (await req2Response.json()) as Record<string, unknown>;
        expect(req2Data.ok).toBe(false);
        expect(req2Data.error).toContain("已有安装任务正在进行中");

        // 触发 req1 超时 abort
        if (abortCallback) {
          (abortCallback as () => void)();
        }

        const req1Response = await req1Promise;
        // m7: 失败时返回 HTTP 500
        expect(req1Response.status).toBe(500);
        const req1Data = (await req1Response.json()) as Record<string, unknown>;
        expect(req1Data.ok).toBe(false);

        // 闸已释放：第三次调用不再返回 409
        globalThis.fetch = (() =>
          Promise.resolve(new Response("fail", { status: 404 }))) as unknown as typeof fetch;

        const req3Response = await installRoutePost();
        expect(req3Response.status).toBe(500); // 是 500 而非 409
        const req3Data = (await req3Response.json()) as Record<string, unknown>;
        expect(req3Data.ok).toBe(false);
        expect(req3Data.error).not.toContain("已有安装任务正在进行中");
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
