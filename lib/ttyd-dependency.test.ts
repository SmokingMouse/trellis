import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  installHint,
  probeExecutable,
  probeSummary,
  serverTtydInstallHint,
  tmuxCandidates,
  ttydCandidates,
  ttydHostDependencyNote,
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
    });
  });

  describe("探测详情文案与折叠机制", () => {
    it("当所有路径均不存在时折叠为『探过 N 个路径，都不存在』", () => {
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
      expect(summary).toBe(`探过 ${result.tried.length} 个路径，都不存在`);
      // 不应展开长路径列表
      expect(summary).not.toContain("/non-existent-bin/ttyd: 不存在");
    });

    it("当有路径存在但无法执行时，展开列出所有尝试过的路径及具体原因", () => {
      const mockResult = {
        path: null,
        tried: [
          { path: "/bin/mock-ttyd-1", reason: "不存在" },
          { path: "/bin/mock-ttyd-2", reason: "EACCES" },
        ],
      };
      const summary = probeSummary(mockResult);
      expect(summary).toBe("/bin/mock-ttyd-1: 不存在; /bin/mock-ttyd-2: EACCES");
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
      expect(serverTtydInstallHint()).toBe("brew install ttyd");
      expect(ttydHostDependencyNote()).toBe("Web 终端依赖宿主机安装 ttyd（brew install ttyd）");
    });

    it("Linux 下 ttyd 界面提示自动安装或手动执行，文案无多重括号结尾，日志提示不含前端动词", () => {
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      const hint = installHint("ttyd");
      expect(hint).toContain("点击下方『自动安装』或手动执行：");
      expect(hint).toContain("curl");
      expect(hint).toContain("chmod +x");
      expect(hint).toContain("1.7.7");

      const msg = ttydMissingMessage();
      expect(msg.endsWith("）")).toBe(true);
      expect(msg.endsWith("））")).toBe(false); // 严禁双重括号结尾

      const serverHint = serverTtydInstallHint();
      expect(serverHint).toContain("下载静态二进制：");
      expect(serverHint).not.toContain("点击下方");

      const serverNote = ttydHostDependencyNote();
      expect(serverNote).toContain("Web 终端依赖宿主机安装 ttyd（下载静态二进制：");
      expect(serverNote).not.toContain("点击下方");

      // Linux 下 tmux 仍是 apt install tmux
      expect(installHint("tmux")).toBe("apt install tmux");
    });
  });
});
