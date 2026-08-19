import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 「谁在长驻拉着 trellis、怎么重启它」这件事的唯一抽象。
//
// 两台实例的 supervisor 不是一回事：本机是 launchd（`launchctl kickstart -k`），
// BOE devbox 是 systemd user unit（`systemctl --user restart trellis`）。
//
// 为什么值得单独一层：S86 那次事故里 kickstart() 写死了 launchctl，在 Linux 上
// `Bun.spawn` 直接 ENOENT 抛错，而抛错点在 switchTo() **内部** —— `current` 软链
// 已经翻到新 release、服务却没重启。那正好落在整套设计唯一的承诺
// 「switch 之前失败 = prod 一根汗毛没动」的缝里：失败发生在 switch 当中。
// 所以这层除了「能重启」，还必须提供一个**能在 preflight 就问清楚**的探针。
//
// 三个 platform 差异都藏在这里，调用方不写 if：
//   ① 重启命令；② 服务定义文件（plist / unit）里 WorkingDirectory 怎么读怎么改；
//   ③ 派生的子进程怎么活过重启（launchd 下 setsid 就够，systemd 下不够，见
//      detachPrefix 的注释）。

export type SupervisorKind = "launchd" | "systemd";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (
  cmd: string[],
  opts?: { quiet?: boolean },
) => Promise<RunResult>;

export type Probe = { ok: true } | { ok: false; reason: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 跑一条命令，把「可执行文件不存在」也变成普通的失败结果。
 *
 * `Bun.spawn` 对 ENOENT 是**抛**而不是返回非零码 —— 探针要的恰恰是这种情况的
 * 答案，不能让它把调用栈炸穿。
 */
async function tryRun(
  run: Runner,
  cmd: string[],
  opts?: { quiet?: boolean },
): Promise<RunResult> {
  try {
    return await run(cmd, opts);
  } catch (e) {
    return {
      code: 127,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

export type Supervisor = {
  kind: SupervisorKind;
  /** 进日志和报错的人话名字 */
  name: string;
  /** 服务定义还在不在、supervisor 认不认它。preflight 用这个决定要不要往下走。 */
  probe(run: Runner): Promise<Probe>;
  /** 重启服务。失败抛错。 */
  restart(run: Runner): Promise<void>;
  /** 服务定义文件的绝对路径；null = 找不到 */
  unitFile(run: Runner): Promise<string | null>;
  /** 服务**当前实际生效**的工作目录；null = 读不出来 */
  workingDirectory(run: Runner): Promise<string | null>;
  /**
   * 把工作目录改成 dir，返回原文件的备份路径。
   * 只改已存在的那一行 —— 定义里压根没这项时抛错，不猜用户的意图。
   */
  setWorkingDirectory(file: string, dir: string): string;
  /** 重新加载改过的服务定义并拉起。false = 服务现在是停着的，调用方必须还原。 */
  reload(run: Runner): Promise<boolean>;
  /** 给 ~/.trellis/bin/rollback.sh 用的重启命令（sh 一行，不依赖仓库和 bun） */
  restartShell(): string;
  /**
   * 派生一个「必须活过重启」的子进程时要加的前缀（见 lib/server/update.ts）。
   *
   * launchd 下空数组就够：`detached: true` 换个会话，job 被 kickstart 掉时
   * 子进程不受牵连。**systemd 下 setsid 是不够的** —— 默认 KillMode=control-group
   * 按 cgroup 杀，换会话不换 cgroup，`systemctl restart` 会把正在跑部署的那个
   * 进程一起带走，于是 verify 和「验活失败自动回滚」两层安全网全失效。要逃就得
   * 真的换 cgroup：systemd-run 起一个 transient scope。
   */
  detachPrefix(): string[];
};

// ── launchd（macOS）─────────────────────────────────────────────────────────

function launchd(label: string): Supervisor {
  const uid = process.getuid?.() ?? 0;
  const target = `gui/${uid}/${label}`;
  const plist = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`);
  const WD = /(<key>WorkingDirectory<\/key>\s*<string>)([^<]*)(<\/string>)/;

  return {
    kind: "launchd",
    name: `launchd job ${target}`,

    async probe(run) {
      const r = await tryRun(run, ["launchctl", "print", target], { quiet: true });
      if (r.code === 0) return { ok: true };
      if (r.code === 127) {
        return { ok: false, reason: `跑不了 launchctl：${r.stderr.trim()}` };
      }
      return {
        ok: false,
        reason: `launchd 里查不到 ${target}（job 没加载？）—— ` +
          `手工加载：launchctl bootstrap gui/${uid} ${plist}`,
      };
    },

    async restart(run) {
      const r = await tryRun(run, ["launchctl", "kickstart", "-k", target]);
      if (r.code !== 0) {
        throw new Error(
          `重启失败（${target}）：${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`,
        );
      }
    },

    async unitFile() {
      return fs.existsSync(plist) ? plist : null;
    },

    async workingDirectory() {
      try {
        const m = fs.readFileSync(plist, "utf8").match(WD);
        return m ? m[2] : null;
      } catch {
        return null;
      }
    },

    setWorkingDirectory(file, dir) {
      const xml = fs.readFileSync(file, "utf8");
      if (!WD.test(xml)) {
        throw new Error(`${file} 里没有 WorkingDirectory，不敢自动改`);
      }
      const backup = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, backup);
      fs.writeFileSync(file, xml.replace(WD, `$1${dir}$3`));
      return backup;
    },

    /**
     * bootout + bootstrap。
     *
     * **`bootout` 是异步的** —— 它返回时 job 未必真的消失了，紧接着 bootstrap 会
     * 撞上还在的旧 job 报 `Bootstrap failed: 5: Input/output error`，然后服务就那么
     * 停着（S79 第一次真上线踩的就是这个，prod 停了约一分钟）。所以要等它真消失，
     * 再带重试地 bootstrap。
     */
    async reload(run) {
      await tryRun(run, ["launchctl", "bootout", target], { quiet: true });
      for (let i = 0; i < 25; i++) {
        const p = await tryRun(run, ["launchctl", "print", target], { quiet: true });
        if (p.code !== 0) break; // 查不到了 = 真的卸载完了
        await sleep(200);
      }
      for (let i = 0; i < 5; i++) {
        const r = await tryRun(run, ["launchctl", "bootstrap", `gui/${uid}`, plist], {
          quiet: i < 4,
        });
        if (r.code === 0) return true;
        await sleep(500 * (i + 1));
      }
      return false;
    },

    restartShell() {
      return `launchctl kickstart -k "gui/$(id -u)/${label}"`;
    },

    detachPrefix() {
      return [];
    },
  };
}

// ── systemd user unit（Linux）───────────────────────────────────────────────

/**
 * unit 名默认取 label 的最后一段：`com.smokingmouse.trellis` → `trellis.service`
 * —— 与 BOE 上现存的那个 unit 对齐。
 */
function unitName(label: string): string {
  const raw = process.env.TRELLIS_DEPLOY_UNIT || label.split(".").pop() || label;
  return raw.endsWith(".service") ? raw : `${raw}.service`;
}

function systemd(label: string): Supervisor {
  const unit = unitName(label);
  const sc = (...args: string[]) => ["systemctl", "--user", ...args];
  // `show -p X --value` 是**运行期真值**：含 drop-in、%h 之类的 specifier 已展开。
  // 直接读 unit 文件读不到这些。
  const show = async (run: Runner, prop: string): Promise<string | null> => {
    const r = await tryRun(run, sc("show", "-p", prop, "--value", unit), {
      quiet: true,
    });
    if (r.code !== 0) return null;
    const v = r.stdout.trim();
    return v || null;
  };
  const WD = /^WorkingDirectory\s*=.*$/m;

  return {
    kind: "systemd",
    name: `systemd user unit ${unit}`,

    async probe(run) {
      const r = await tryRun(run, sc("show", "-p", "LoadState", "--value", unit), {
        quiet: true,
      });
      if (r.code === 127) {
        return { ok: false, reason: `跑不了 systemctl：${r.stderr.trim()}` };
      }
      if (r.code !== 0) {
        return {
          ok: false,
          reason:
            `systemctl --user 用不了（${(r.stderr || r.stdout).trim() || `exit ${r.code}`}）—— ` +
            `user manager 没起来？检查 XDG_RUNTIME_DIR / loginctl enable-linger`,
        };
      }
      const st = r.stdout.trim();
      if (st !== "loaded") {
        return {
          ok: false,
          reason:
            `${unit} 的 LoadState=${st || "(空)"}，不是 loaded —— ` +
            `unit 不存在或有语法错。换个名字用 TRELLIS_DEPLOY_UNIT=<名> 指定`,
        };
      }
      return { ok: true };
    },

    async restart(run) {
      const r = await tryRun(run, sc("restart", unit));
      if (r.code !== 0) {
        throw new Error(
          `重启失败（${unit}）：${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`,
        );
      }
    },

    // FragmentPath = systemd 实际加载的那个文件。别猜 ~/.config/systemd/user/
    // —— unit 也可能装在 /etc/systemd/user 或是个软链。
    async unitFile(run) {
      const p = await show(run, "FragmentPath");
      return p && fs.existsSync(p) ? p : null;
    },

    async workingDirectory(run) {
      return await show(run, "WorkingDirectory");
    },

    setWorkingDirectory(file, dir) {
      const text = fs.readFileSync(file, "utf8");
      if (!WD.test(text)) {
        throw new Error(`${file} 里没有 WorkingDirectory=，不敢自动改`);
      }
      const backup = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, backup);
      fs.writeFileSync(file, text.replace(WD, `WorkingDirectory=${dir}`));
      return backup;
    },

    async reload(run) {
      const d = await tryRun(run, sc("daemon-reload"), { quiet: true });
      if (d.code !== 0) return false;
      const r = await tryRun(run, sc("restart", unit));
      if (r.code !== 0) return false;
      // restart 返回 0 只说明「命令被接受」。真起来了没有要另外问一句 ——
      // 起不来的 unit 会在几百毫秒后掉进 failed，那时才是真答案。
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        const st = await show(run, "ActiveState");
        if (st === "active") return true;
        if (st === "failed") return false;
      }
      return false;
    },

    restartShell() {
      return `systemctl --user restart ${unit}`;
    },

    detachPrefix() {
      return ["systemd-run", "--user", "--collect", "--quiet", "--scope"];
    },
  };
}

// ── 选型 ───────────────────────────────────────────────────────────────────

/** launchd 的 job label；systemd 的 unit 名默认从它的最后一段派生。 */
export function deployLabel(): string {
  return process.env.TRELLIS_DEPLOY_LABEL || "com.smokingmouse.trellis";
}

/**
 * 当前机器用哪套。`TRELLIS_DEPLOY_SUPERVISOR=launchd|systemd` 可强制覆盖
 * （本机演练 Linux 路径时用得上，见 progress/facts.md）。
 */
export function resolveSupervisor(label: string = deployLabel()): Supervisor {
  const forced = process.env.TRELLIS_DEPLOY_SUPERVISOR;
  if (forced === "launchd") return launchd(label);
  if (forced === "systemd") return systemd(label);
  if (forced) {
    throw new Error(
      `TRELLIS_DEPLOY_SUPERVISOR=${forced} 不认识（只有 launchd / systemd）`,
    );
  }
  return process.platform === "darwin" ? launchd(label) : systemd(label);
}
