import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeExecutable,
  probeSummary,
  ttydCandidates,
  type ProbeAttempt,
} from "@/lib/ttyd-dependency";

// Linux 上 Web 终端「未找到 ttyd」自愈：一键下载对应架构的静态二进制。
// 版本钉死 1.7.7，sha256 钉死在代码里。
// 来源：https://github.com/tsl0922/ttyd/releases/tag/1.7.7 的 SHA256SUMS：
//   b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165  ttyd.aarch64
//   8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55  ttyd.x86_64

export const TTYD_RELEASE_VERSION = "1.7.7";

export const TTYD_ARCH_ASSETS: Record<string, { asset: string; sha256: string }> = {
  x64: {
    asset: "ttyd.x86_64",
    sha256: "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55",
  },
  arm64: {
    asset: "ttyd.aarch64",
    sha256: "b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165",
  },
};

export function manualInstallCommand(asset: string = "ttyd.x86_64"): string {
  return `mkdir -p ~/.trellis/bin && curl -fsSL -o ~/.trellis/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/${asset} && chmod +x ~/.trellis/bin/ttyd`;
}

export type FetchLike = (
  input: RequestInfo | URL | string,
  init?: RequestInit & { proxy?: string; dispatcher?: unknown },
) => Promise<Response>;

export type InstallTtydOptions = {
  platform?: string;
  arch?: string;
  targetDir?: string;
  fetchFn?: FetchLike;
  expectedSha256?: string;
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
 * 2. 根据 CPU 架构映射 release 资产（x64 / arm64），其余报错；
 * 3. 尊重 https_proxy / HTTPS_PROXY 环境变量；
 * 4. 写入同目录临时文件，sha256 校验不符立即清理，绝不残留半截损坏文件；
 * 5. chmod 755 后原子重命名到目标路径 ~/.trellis/bin/ttyd；
 * 6. 重新执行探测并返回完整结果；任何失败均带可读原因与手动安装命令。
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
      error: `不支持的 CPU 架构: ${arch}（自动安装仅支持 x64 和 arm64）。手动安装请下载对应资产到 ~/.trellis/bin/ttyd 并赋予执行权限`,
      platform,
      arch,
    };
  }

  const manualCmd = manualInstallCommand(targetAsset.asset);
  const downloadUrl = `https://github.com/tsl0922/ttyd/releases/download/${TTYD_RELEASE_VERSION}/${targetAsset.asset}`;

  const home = process.env.HOME || os.homedir();
  const targetDir = options?.targetDir ?? path.join(home, ".trellis", "bin");
  const targetPath = path.join(targetDir, "ttyd");
  const tempPath = path.join(
    targetDir,
    `.ttyd.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );

  let tempFileCreated = false;

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    // 处理代理（Bun 原生支持 proxy 选项；若在 Node 环境则尝试 undici ProxyAgent）
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
    const fetchFn = options?.fetchFn ?? globalThis.fetch;
    const fetchOpts: RequestInit & { proxy?: string; dispatcher?: unknown } = {};
    if (proxyUrl) {
      fetchOpts.proxy = proxyUrl;
      try {
        const importDynamic = new Function("m", "return import(m)");
        const undici = (await importDynamic("undici")) as {
          ProxyAgent?: new (url: string) => unknown;
        };
        if (undici?.ProxyAgent) {
          fetchOpts.dispatcher = new undici.ProxyAgent(proxyUrl);
        }
      } catch {
        /* 忽略，Bun 原生 fetch 已支持 proxy 选项 */
      }
    }

    const res = await fetchFn(downloadUrl, fetchOpts);
    if (!res.ok) {
      throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}（手动命令：${manualCmd}）`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tempPath, buffer);
    tempFileCreated = true;

    // 校验 sha256
    const expectedSha256 = options?.expectedSha256 ?? targetAsset.sha256;
    const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    if (actualSha256 !== expectedSha256) {
      fs.unlinkSync(tempPath);
      tempFileCreated = false;
      throw new Error(
        `SHA256 校验失败: 期望 ${expectedSha256}，实际计算得到 ${actualSha256}。手动命令：${manualCmd}`,
      );
    }

    // 赋予执行权限并原子重命名
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, targetPath);
    tempFileCreated = false;

    // 重新探测
    const probe = probeExecutable("ttyd", [targetPath, ...ttydCandidates()], "--version");
    if (!probe.path) {
      return {
        ok: false,
        path: null,
        tried: probe.tried,
        error: `ttyd 已下载并保存到 ${targetPath}，但探测启动失败（${probeSummary(probe)}）。手动命令：${manualCmd}`,
        platform,
        arch,
      };
    }

    return {
      ok: true,
      path: probe.path,
      tried: probe.tried,
      platform,
      arch,
    };
  } catch (err: unknown) {
    if (tempFileCreated) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 忽略清理错误 */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path: null,
      tried: probeExecutable("ttyd", ttydCandidates(), "--version").tried,
      error: `ttyd 安装失败：${message}`,
      platform,
      arch,
    };
  }
}
