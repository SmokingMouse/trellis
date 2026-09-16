import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeExecutable,
  probeSingleExecutable,
  probeSummary,
  ttydCandidates,
  type ProbeAttempt,
} from "@/lib/ttyd-dependency";

// Linux 上 Web 终端「未找到 ttyd」自愈：一键下载对应架构的静态二进制。
// 版本钉死 1.7.7，sha256 钉死在代码里。
// 来源：https://github.com/tsl0922/ttyd/releases/tag/1.7.7 的 SHA256SUMS：
//   b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165  ttyd.aarch64
//   8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55  ttyd.x86_64
//   05eac1223914f18c65898d72c8d14e76bbb5435f7762c6dc7f16f041994a8109  ttyd.arm
//   93e112e19c9c0dcc717e98bdba0f43fc50f0c74ae1ba5b572772c507654ed19c  ttyd.i686

export const TTYD_RELEASE_VERSION = "1.7.7";
export const MAX_TTYD_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB 上限（ttyd 静态二进制约 1.4MB）
export const DEFAULT_TTYD_TIMEOUT_MS = 60_000; // 60s 超时

export const TTYD_ARCH_ASSETS: Record<string, { asset: string; sha256: string }> = {
  x64: {
    asset: "ttyd.x86_64",
    sha256: "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55",
  },
  arm64: {
    asset: "ttyd.aarch64",
    sha256: "b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165",
  },
  arm: {
    asset: "ttyd.arm",
    sha256: "05eac1223914f18c65898d72c8d14e76bbb5435f7762c6dc7f16f041994a8109",
  },
  ia32: {
    asset: "ttyd.i686",
    sha256: "93e112e19c9c0dcc717e98bdba0f43fc50f0c74ae1ba5b572772c507654ed19c",
  },
};

export function manualInstallCommand(asset: string = "ttyd.x86_64"): string {
  return `mkdir -p ~/.trellis/bin && curl -fsSL -o ~/.trellis/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/${asset} && chmod +x ~/.trellis/bin/ttyd`;
}

export type FetchLike = (
  input: RequestInfo | URL | string,
  init?: RequestInit & { proxy?: string },
) => Promise<Response>;

export type InstallTtydOptions = {
  platform?: string;
  arch?: string;
  targetDir?: string;
  fetchFn?: FetchLike;
  expectedSha256?: string;
  timeoutMs?: number;
};

export type InstallTtydResult = {
  ok: boolean;
  path: string | null;
  tried: ProbeAttempt[];
  error?: string;
  platform?: string;
  arch?: string;
};

/**
 * 在 Linux 上自动下载并安装 ttyd 静态二进制。
 *
 * 1. 仅 linux 生效（macOS 提示 brew install）；
 * 2. 根据 CPU 架构映射 release 资产（x64 / arm64 / arm / ia32），其余报错；
 * 3. 尊重 https_proxy / HTTPS_PROXY 环境变量（依赖 Bun 原生 proxy 支持）；
 * 4. 设置 60s 超时与 20MB 下载上限，防止挂死或内存暴涨；
 * 5. 写盘前登记临时文件并在 finally 中安全清理，sha256 校验不符立即清理，绝不残留半截损坏文件；
 * 6. chmod 755 后原子重命名到目标路径 ~/.trellis/bin/ttyd；
 * 7. 重新探测：先单独验证刚下载的文件能否执行，确认后再进行全表探测。
 */
export async function installTtyd(options?: InstallTtydOptions): Promise<InstallTtydResult> {
  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;

  if (platform !== "linux") {
    return {
      ok: false,
      path: null,
      tried: [],
      error: "自动安装仅支持 Linux 系统（macOS 请运行 brew install ttyd）",
      platform,
      arch,
    };
  }

  const targetAsset = TTYD_ARCH_ASSETS[arch];
  if (!targetAsset) {
    return {
      ok: false,
      path: null,
      tried: [],
      error: `不支持的 CPU 架构: ${arch}（自动安装仅支持 x64, arm64, arm, ia32）。手动安装请下载对应资产到 ~/.trellis/bin/ttyd 并赋予执行权限`,
      platform,
      arch,
    };
  }

  const manualCmd = manualInstallCommand(targetAsset.asset);
  const downloadUrl = `https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/${targetAsset.asset}`;

  const home = process.env.HOME || os.homedir();
  const targetDir = options?.targetDir ?? path.join(home, ".trellis", "bin");
  const targetPath = path.join(targetDir, "ttyd");
  let tempPath: string | null = path.join(
    targetDir,
    `.ttyd.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TTYD_TIMEOUT_MS;

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    // 处理代理（Bun 原生支持 proxy 选项）
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
    const fetchFn = options?.fetchFn ?? globalThis.fetch;
    const fetchOpts: RequestInit & { proxy?: string } = {
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (proxyUrl) {
      fetchOpts.proxy = proxyUrl;
    }

    const res = await fetchFn(downloadUrl, fetchOpts);
    if (!res.ok) {
      throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}（手动命令：${manualCmd}）`);
    }

    // 检查响应头 Content-Length（M1）
    const contentLength = Number(res.headers.get("content-length"));
    if (contentLength && contentLength > MAX_TTYD_DOWNLOAD_BYTES) {
      throw new Error(`下载文件大小超过限制 (Content-Length: ${contentLength} 字节，上限 20MB)`);
    }

    // 流式读取并限制实际读入字节（M1）
    let buffer: Buffer;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.length;
            if (totalBytes > MAX_TTYD_DOWNLOAD_BYTES) {
              await reader.cancel();
              throw new Error(`下载文件体积超出限制 (已接收 ${totalBytes} 字节，上限 20MB)`);
            }
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock?.();
      }
      buffer = Buffer.concat(chunks);
    } else {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > MAX_TTYD_DOWNLOAD_BYTES) {
        throw new Error(`下载文件体积超出限制 (已接收 ${ab.byteLength} 字节，上限 20MB)`);
      }
      buffer = Buffer.from(ab);
    }

    // 写盘前 tempPath 已登记（M2）
    fs.writeFileSync(tempPath, buffer);

    // 校验 sha256
    const expectedSha256 = options?.expectedSha256 ?? targetAsset.sha256;
    const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `SHA256 校验失败: 期望 ${expectedSha256}，实际计算得到 ${actualSha256}。手动命令：${manualCmd}`,
      );
    }

    // 赋予执行权限并原子重命名
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, targetPath);
    tempPath = null; // 重命名成功后释放，避免 finally 误删目标文件

    // 重新探测：先单独探 targetPath（只用它自己跑 --version，M3）
    const singleFailure = probeSingleExecutable(targetPath, "--version");
    if (singleFailure) {
      // 跑不起来的二进制不能留在 ~/.trellis/bin：它是候选表第一条，留着会让此后每次探测
      // 都先撞上 ENOEXEC，探测详情随之刷满整个 PATH（复审 n1）。删掉，回到「未安装」态。
      try {
        fs.unlinkSync(targetPath);
      } catch {
        // 删不掉也只是多一条探测失败记录，不影响返回
      }
      return {
        ok: false,
        path: null,
        tried: [singleFailure],
        error: `已下载到 ${targetPath} 但无法执行（${singleFailure.reason}），已删除。手动命令：${manualCmd}`,
        platform,
        arch,
      };
    }

    // targetPath 确认可用后再进行全表探测
    const probe = probeExecutable("ttyd", [targetPath, ...ttydCandidates()], "--version");
    return {
      ok: true,
      path: probe.path ?? targetPath,
      tried: probe.tried,
      platform,
      arch,
    };
  } catch (err: unknown) {
    let message = err instanceof Error ? err.message : String(err);
    // 只认 AbortSignal.timeout 抛出的错误名，不按文案猜：网关返回的任何带 "timeout" 字样的
    // 错误都不该被改写成「下载超时」而吞掉真实原因（复审 n2）。
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      message = `下载超时（${Math.round(timeoutMs / 1000)}s）`;
    }

    return {
      ok: false,
      path: null,
      tried: probeExecutable("ttyd", ttydCandidates(), "--version").tried,
      error: `ttyd 安装失败：${message}`,
      platform,
      arch,
    };
  } finally {
    // 临时文件清理保证（M2）
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 忽略清理错误 */
      }
    }
  }
}
