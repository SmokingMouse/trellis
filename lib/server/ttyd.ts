import "server-only";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

// S1 P1（progress/project-workspace-layer.md）：工作区终端的后端进程。
//
// 为什么是外部进程而不是跑在 trellis 里：bun 下没有可用 pty
// （node-pty 的 onData 永不触发、`Bun.spawn({pty:true})` 是假的），而 trellis
// 必须跑 bun（bun:sqlite）。ttyd 是独立 C 二进制，与 bun 运行时无关。
//
// 为什么浏览器直连而不是经 trellis 反代：bun 的 node:http upgrade socket
// 写不回客户端（writable=true、write() 返回 true、客户端收 0 字节；同代码
// node v24 正常），Next 的 rewrites 也不透传 WS upgrade。两条路都实测堵死。
// 所以 ttyd 只绑 127.0.0.1，靠「远程连不上」而不是「cookie 闸」来兜安全。

// tmux 在交互 shell 里会被 oh-my-zsh 的插件函数遮蔽
// （`_zsh_tmux_plugin_run: command not found`），所以一律走绝对路径，
// 不依赖 PATH 解析。
const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
const TTYD_CANDIDATES = ["/opt/homebrew/bin/ttyd", "/usr/local/bin/ttyd", "/usr/bin/ttyd"];

function firstExisting(paths: string[], probeArg: string): string | null {
  for (const p of paths) {
    const r = spawnSync(p, [probeArg], { encoding: "utf8", timeout: 4000 });
    if (!r.error) return p;
  }
  return null;
}

let _tmux: string | null | undefined;
export function tmuxBin(): string | null {
  if (_tmux === undefined) _tmux = firstExisting(TMUX_CANDIDATES, "-V");
  return _tmux;
}

let _ttyd: string | null | undefined;
function ttydBin(): string | null {
  if (_ttyd === undefined) _ttyd = firstExisting(TTYD_CANDIDATES, "--version");
  return _ttyd;
}

// ttyd 会读 http_proxy —— 本机 clash 把它污染成非 `ads:port` 格式时会刷
// `lws_set_proxy: http_proxy needs to be ads:port` 错（不致命，但刷屏且是
// 假信号）。拉起时清干净。
function cleanEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    http_proxy: "",
    https_proxy: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    all_proxy: "",
    no_proxy: "*",
  };
}

type State = {
  port: number | null;
  proc: ChildProcess | null;
  starting: Promise<number | null> | null;
  /** 拉不起来的原因，给 UI 显示真话而不是干转圈 */
  error: string | null;
};

const state: State = { port: null, proc: null, starting: null, error: null };

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    const done = (free: boolean) => {
      sock.destroy();
      resolve(free);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    setTimeout(() => done(true), 400);
  });
}

function listening(port: number): Promise<boolean> {
  return portFree(port).then((free) => !free);
}

// ttyd 是 trellis spawn 出来的子进程，但**不会随父进程一起死**：实测 kill 掉
// trellis 后，旧 ttyd 仍在原端口 LISTEN 变成孤儿，下次启动 pickPort 跳过被占的
// 端口漂到下一个 —— 每重启一次泄漏一个进程 + 一个端口。
//
// 所以启动前先按签名清一遍。签名用 `titleFixed trellis`（我们自己下发的
// ttyd client option），足够独特，不会误杀用户自己跑的 ttyd。
// **只杀真正的孤儿**：父进程已死的那些。
//
// 光按签名杀是错的 —— 签名认不出「这个 ttyd 是谁家的」。同时跑两个 trellis
// （prod + 一个隔离实例，或两个 worktree 实例）时，后启动的会把先启动的那个
// ttyd 杀掉，用户的终端就此死亡、下次连接要重付一次 shell 启动
// （实测：复用已有 tmux session 首字节 8ms，全新 session 588ms —— 差的全是
// 交互式 zsh 的启动开销）。
//
// 判据用 PPID：父进程死掉后子进程会被 reparent 到 launchd（PID 1），
// 所以 `ppid == 1` 就是「它的 trellis 已经不在了」，而被活着的实例持有的
// ttyd 其 ppid 是那个实例的 pid。精确、无需额外标记。
function reapOrphans(): number {
  const found = spawnSync(
    "pgrep",
    ["-f", "ttyd .*titleFixed trellis"],
    { encoding: "utf8", timeout: 4000 },
  );
  if (found.error || !found.stdout) return 0;
  let n = 0;
  for (const line of found.stdout.trim().split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const ppidOut = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 4000,
    });
    const ppid = Number((ppidOut.stdout ?? "").trim());
    if (ppid !== 1) continue; // 还有活着的主人，不是孤儿
    try {
      process.kill(pid, "SIGTERM");
      n++;
    } catch {
      /* 已经没了 */
    }
  }
  if (n > 0) console.log(`[trellis] reaped ${n} orphan ttyd process(es)`);
  return n;
}

async function pickPort(): Promise<number | null> {
  const forced = Number(process.env.TRELLIS_TTYD_PORT);
  if (Number.isInteger(forced) && forced > 0) return forced;
  for (let p = 7681; p < 7681 + 40; p++) {
    if (await portFree(p)) return p;
  }
  return null;
}

/**
 * 拉起 ttyd（幂等，重复调用返回同一个端口）。
 *
 * 命令固定成 `tmux new -A -s`，session 名与 cwd 全靠 URL 的 `?arg=` 传进来
 * （`-a` / `--url-arg`）—— 这样**一个 ttyd 进程就能服务任意多 workspace 的
 * 任意多终端**，不用为每个终端各起一个进程各占一个端口。
 *
 * `-W` 是可写（ttyd 默认只读）。`-t` 关掉离开确认弹窗，否则 iframe 卸载时
 * 浏览器会拦一下。
 */
export function startTtyd(): Promise<number | null> {
  if (state.port) return Promise.resolve(state.port);
  if (state.starting) return state.starting;

  state.starting = (async () => {
    const ttyd = ttydBin();
    const tmux = tmuxBin();
    if (!ttyd) {
      state.error = "未找到 ttyd（安装：brew install ttyd）";
      return null;
    }
    if (!tmux) {
      state.error = "未找到 tmux（安装：brew install tmux）";
      return null;
    }
    // 先收尸再选端口 —— 否则孤儿占着 7681，新实例只能漂到 7682，越漂越远。
    if (reapOrphans() > 0) await new Promise((r) => setTimeout(r, 300));

    const port = await pickPort();
    if (!port) {
      state.error = "7681-7720 无空闲端口";
      return null;
    }

    const proc = spawn(
      ttyd,
      [
        "-p", String(port),
        "-i", "127.0.0.1", // 只绑本机：这就是整个安全模型
        "-a",              // 允许 URL 传 args（session 名 + cwd）
        "-W",              // 可写
        "-t", "disableLeaveAlert=true",
        "-t", "titleFixed=trellis",
        tmux, "new", "-A", "-s",
      ],
      { env: cleanEnv(), stdio: "ignore", detached: false },
    );
    proc.on("exit", (code) => {
      if (state.proc === proc) {
        state.proc = null;
        state.port = null;
        state.error = `ttyd 退出（code=${code}）`;
      }
    });
    state.proc = proc;

    // 实测：ttyd 从 spawn 到真正 `Listening on port` 有 ~3.5s 延迟
    // （16:19:01 启动 → 16:19:04 才 bind）。sleep 一个固定值必然抢跑，
    // 必须轮询探活。
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) break;
      if (await listening(port)) {
        state.port = port;
        state.error = null;
        console.log(`[trellis] ttyd listening on 127.0.0.1:${port}`);
        return port;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    state.error = "ttyd 启动超时（15s 未监听）";
    try {
      proc.kill();
    } catch {
      /* 已经死了 */
    }
    state.proc = null;
    return null;
  })();

  const p = state.starting;
  p.finally(() => {
    if (state.starting === p) state.starting = null;
  });
  return p;
}

export function ttydStatus(): { port: number | null; error: string | null } {
  return { port: state.port, error: state.error };
}

export function stopTtyd(): void {
  // 只杀 ttyd，**刻意不碰 tmux server** —— tmux session 活着正是
  // 「trellis 重启不丢终端」这个特性本身。
  if (state.proc) {
    try {
      state.proc.kill();
    } catch {
      /* 忽略 */
    }
  }
  state.proc = null;
  state.port = null;
}
