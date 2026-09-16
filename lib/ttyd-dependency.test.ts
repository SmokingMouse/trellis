import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  installHint,
  probeExecutable,
  probeSummary,
  TMUX_CANDIDATES,
  tmuxCandidates,
  TTYD_CANDIDATES,
  ttydCandidates,
  ttydMissingMessage,
} from "./ttyd-dependency";

describe("lib/ttyd-dependency", () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  describe("候选路径顺序", () => {
    it("ttyd 优先使用 TRELLIS_TTYD_BIN，其次 ~/.trellis/bin 与 ~/.local/bin，再到系统路径与 snap", () => {
      const mockHome = "/custom/mock-home";
      const mockBin = "/opt/custom/env-ttyd";
      process.env.HOME = mockHome;
      process.env.TRELLIS_TTYD_BIN = mockBin;

      const candidates = ttydCandidates();
      expect(candidates[0]).toBe(mockBin);
      expect(candidates[1]).toBe(path.join(mockHome, ".trellis", "bin", "ttyd"));
      expect(candidates[2]).toBe(path.join(mockHome, ".local", "bin", "ttyd"));
      expect(candidates[3]).toBe("/opt/homebrew/bin/ttyd");
      expect(candidates[4]).toBe("/usr/local/bin/ttyd");
      expect(candidates[5]).toBe("/usr/bin/ttyd");
      expect(candidates[6]).toBe("/snap/bin/ttyd");

      // 验证导出的 TTYD_CANDIDATES 也具有相同顺序
      expect([...TTYD_CANDIDATES]).toEqual(candidates);
    });

    it("tmux 优先使用 TRELLIS_TMUX_BIN，其次 ~/.local/bin，再到系统路径", () => {
      const mockHome = "/custom/mock-home";
      const mockTmux = "/opt/custom/env-tmux";
      process.env.HOME = mockHome;
      process.env.TRELLIS_TMUX_BIN = mockTmux;

      const candidates = tmuxCandidates();
      expect(candidates[0]).toBe(mockTmux);
      expect(candidates[1]).toBe(path.join(mockHome, ".local", "bin", "tmux"));
      expect(candidates[2]).toBe("/opt/homebrew/bin/tmux");
      expect(candidates[3]).toBe("/usr/local/bin/tmux");
      expect(candidates[4]).toBe("/usr/bin/tmux");

      expect([...TMUX_CANDIDATES]).toEqual(candidates);
    });
  });

  describe("探测详情文案", () => {
    it("列出全部尝试过的路径及各自原因", () => {
      process.env.HOME = "/non-existent-home";
      process.env.TRELLIS_TTYD_BIN = "/non-existent-bin/ttyd";
      process.env.PATH = "/fake-path-a:/fake-path-b";

      const candidates = [
        process.env.TRELLIS_TTYD_BIN,
        "/non-existent-home/.trellis/bin/ttyd",
        "/non-existent-home/.local/bin/ttyd",
      ];

      const result = probeExecutable("ttyd", candidates, "--version");
      expect(result.path).toBeNull();
      expect(result.tried.length).toBeGreaterThanOrEqual(3);

      const summary = probeSummary(result);
      // 必须包含环境变量路径和新候选路径
      expect(summary).toContain("/non-existent-bin/ttyd: 不存在");
      expect(summary).toContain("/non-existent-home/.trellis/bin/ttyd: 不存在");
      expect(summary).toContain("/non-existent-home/.local/bin/ttyd: 不存在");
      expect(summary).toContain("/fake-path-a/ttyd: 不存在");
    });
  });

  describe("installHint 按平台生成提示", () => {
    it("macOS (darwin) 下提示 brew install", () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });

      expect(installHint("ttyd")).toBe("brew install ttyd");
      expect(installHint("tmux")).toBe("brew install tmux");
      expect(ttydMissingMessage()).toBe("未找到 ttyd（安装：brew install ttyd）");
    });

    it("Linux 下 ttyd 提示自动安装或手动下载静态二进制（含 curl 与 chmod +x）", () => {
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      const hint = installHint("ttyd");
      expect(hint).toContain("点击下方『自动安装』或手动下载静态二进制到 ~/.trellis/bin/ttyd");
      expect(hint).toContain("curl");
      expect(hint).toContain("chmod +x");
      expect(hint).toContain("1.7.7");

      // Linux 下 tmux 仍是 apt install tmux
      expect(installHint("tmux")).toBe("apt install tmux");
    });
  });
});
