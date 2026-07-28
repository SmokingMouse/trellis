import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeExecutable,
  probeSummary,
  type ProbeResult,
  TTYD_CANDIDATES,
  TTYD_HOST_DEPENDENCY_NOTE,
  TTYD_MISSING_MESSAGE,
} from "@/lib/ttyd-dependency";

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

// **只缓存成功，不缓存失败**。原来是 `if (_x === undefined) _x = probe()`，
// 把 null 也一并记住了 —— 一次瞬时探测失败（fork EAGAIN / 4s 超时）就把
// 「未找到 ttyd」焊死到进程重启为止，而磁盘上 ttyd 好端端在那儿，界面还一直
// 在喊「brew install ttyd」。不对称是有理由的：探到路径是稳定事实（二进制不会
// 自己跑掉），探不到不是（可能只是那一瞬间 fork 不出来）。
let _tmux: string | null = null;
export function tmuxBin(): string | null {
  if (!_tmux) _tmux = probeExecutable("tmux", TMUX_CANDIDATES, "-V").path;
  return _tmux;
}

let _ttyd: string | null = null;
function ttydProbe(): ProbeResult {
  if (_ttyd) return { path: _ttyd, tried: [] };
  const r = probeExecutable("ttyd", TTYD_CANDIDATES, "--version");
  if (r.path) _ttyd = r.path;
  return r;
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
  /** 接管来的 ttyd 没有 ChildProcess 句柄，只能按 pid 收（见 adoptOwn） */
  adoptedPid: number | null;
  starting: Promise<number | null> | null;
  /** 拉不起来的原因，给 UI 显示真话而不是干转圈 */
  error: string | null;
  /** 排查用的证据（探了哪些路径、各自为什么不行）。与 error 分开，
   *  是为了让界面主行保持一句话，细节收进折叠区。 */
  errorDetail: string | null;
};

const state: State = {
  port: null,
  proc: null,
  adoptedPid: null,
  starting: null,
  error: null,
  errorDetail: null,
};

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
// 端口漂到下一个 —— 每重启一次泄漏一个进程 + 一个端口。所以要收尸。
//
// 但「谁是孤儿」这个判据踩过一次坑，值得写清楚：
//
// 原判据是 PPID —— 父死后子进程 reparent 到 launchd，所以 `ppid == 1` 即孤儿。
// **这个假设在本机不成立**：实测 prod 正在服务的 ttyd（pid 25990）ppid 就是 1，
// 而它的 trellis 实例（next start pid 76269）活得好好的、子进程列表是空的
// （Next 的 route handler 可能跑在一个会被回收的 worker 里，spawn 出来的 ttyd
// 于是提前 reparent）。后果：**每起一个隔离测试实例都会 SIGTERM 掉 prod 的终端**。
//
// 新判据不猜进程树，改成显式登记：拉起 ttyd 时把 `{ttydPort, pid, ownerPort}`
// 写进 ~/.trellis/ttyd/<ttydPort>.json，ownerPort = 本 trellis 实例 Next 的内部
// 端口（server.ts 通过 env PORT 下发，prod=3187、smoke=3998，天然唯一）。
// 「主人还在不在」= 探 ownerPort 有没有人监听，与进程树无关。
//
// 三条规则：
//   1. 有登记且 ownerPort 仍在监听 → 别人家活着的，绝不碰；
//   2. 有登记且 ownerPort 已死 → 真孤儿，杀掉 + 删登记；
//   3. **没有登记的一律不杀** —— 认不出主人时保守放过（顶多占个端口，
//      pickPort 会绕开），比误杀用户正在用的终端便宜得多。
const TTYD_REG_DIR = path.join(os.homedir(), ".trellis", "ttyd");

type TtydRecord = {
  ttydPort: number;
  pid: number;
  /** 本实例 Next 的内部端口；null = 认不出主人（dev 直跑），永不被他人回收 */
  ownerPort: number | null;
  startedAt: string;
};

/** 本实例的身份。server.ts spawn Next 时下发 PORT=<NEXT_PORT>。 */
function ownerPort(): number | null {
  const p = Number(process.env.PORT);
  return Number.isInteger(p) && p > 0 ? p : null;
}

function readRecords(): TtydRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(TTYD_REG_DIR);
  } catch {
    return [];
  }
  const out: TtydRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const r = JSON.parse(
        fs.readFileSync(path.join(TTYD_REG_DIR, n), "utf8"),
      ) as TtydRecord;
      if (Number.isInteger(r?.ttydPort)) out.push(r);
    } catch {
      /* 半截/损坏的登记，忽略 */
    }
  }
  return out;
}

function recordPath(ttydPort: number): string {
  return path.join(TTYD_REG_DIR, `${ttydPort}.json`);
}

function writeRecord(r: TtydRecord): void {
  try {
    fs.mkdirSync(TTYD_REG_DIR, { recursive: true });
    fs.writeFileSync(recordPath(r.ttydPort), JSON.stringify(r));
  } catch {
    /* 登记失败不该拦着终端可用 —— 代价只是这个 ttyd 将来没人替它收尸 */
  }
}

function dropRecord(ttydPort: number): void {
  try {
    fs.unlinkSync(recordPath(ttydPort));
  } catch {
    /* 本来就没有 */
  }
}

async function reapOrphans(): Promise<number> {
  let n = 0;
  const mine = ownerPort();
  for (const r of readRecords()) {
    if (r.ownerPort === null) continue; // 认不出主人，规则 3
    if (r.ownerPort === mine) continue; // 自己上一条命的登记，交给 adopt 处理
    if (await listening(r.ownerPort)) continue; // 规则 1：主人还活着
    try {
      process.kill(r.pid, "SIGTERM"); // 规则 2
      n++;
    } catch {
      /* 已经没了 */
    }
    dropRecord(r.ttydPort);
  }
  if (n > 0) console.log(`[trellis] reaped ${n} orphan ttyd process(es)`);
  return n;
}

/**
 * 上一条命留下的 ttyd 还在监听就直接接管，不再新起一个。
 *
 * 崩溃重启（没走到 stopTtyd）后本来会留一个占着 7681 的孤儿，而它的 ownerPort
 * 正是重启后的自己 —— 谁也回收不掉。接管既堵住这个泄漏，又顺带让「trellis 重启
 * 不丢终端」变成零重连成本（tmux session 和 ttyd 进程都还是原来那个）。
 */
async function adoptOwn(): Promise<TtydRecord | null> {
  const mine = ownerPort();
  if (mine === null) return null;
  for (const r of readRecords()) {
    if (r.ownerPort !== mine) continue;
    if (await listening(r.ttydPort)) return r;
    dropRecord(r.ttydPort); // 记录过期了
  }
  return null;
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
    const adopted = await adoptOwn();
    if (adopted) {
      state.port = adopted.ttydPort;
      state.adoptedPid = adopted.pid;
      state.error = null;
      state.errorDetail = null;
      console.log(
        `[trellis] adopted existing ttyd on 127.0.0.1:${adopted.ttydPort} (pid ${adopted.pid})`,
      );
      return adopted.ttydPort;
    }

    const probe = ttydProbe();
    const ttyd = probe.path;
    const tmux = tmuxBin();
    if (!ttyd) {
      const detail = probeSummary(probe);
      state.error = TTYD_MISSING_MESSAGE;
      state.errorDetail = detail;
      console.warn(`[trellis] ${TTYD_HOST_DEPENDENCY_NOTE}｜探测：${detail}`);
      return null;
    }
    if (!tmux) {
      state.error = "未找到 tmux（安装：brew install tmux）";
      state.errorDetail = null;
      return null;
    }
    // 先收尸再选端口 —— 否则孤儿占着 7681，新实例只能漂到 7682，越漂越远。
    // 钉死了端口（smoke / 隔离实例）就整段跳过：这种实例只该管自己那一个端口，
    // 不该对别人家的 ttyd 有任何动作。
    if (!process.env.TRELLIS_TTYD_PORT) {
      if ((await reapOrphans()) > 0) await new Promise((r) => setTimeout(r, 300));
    }

    const port = await pickPort();
    if (!port) {
      state.error = "7681-7720 无空闲端口";
      state.errorDetail = null;
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
      dropRecord(port);
      if (state.proc === proc) {
        state.proc = null;
        state.port = null;
        state.error = `ttyd 退出（code=${code}）`;
        state.errorDetail = null;
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
        state.errorDetail = null;
        writeRecord({
          ttydPort: port,
          pid: proc.pid ?? -1,
          ownerPort: ownerPort(),
          startedAt: new Date().toISOString(),
        });
        console.log(`[trellis] ttyd listening on 127.0.0.1:${port}`);
        return port;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    state.error = "ttyd 启动超时（15s 未监听）";
    state.errorDetail = null;
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

export function ttydStatus(): {
  port: number | null;
  error: string | null;
  errorDetail: string | null;
} {
  return { port: state.port, error: state.error, errorDetail: state.errorDetail };
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
  } else if (state.adoptedPid !== null) {
    try {
      process.kill(state.adoptedPid, "SIGTERM");
    } catch {
      /* 已经没了 */
    }
  }
  if (state.port !== null) dropRecord(state.port);
  state.proc = null;
  state.adoptedPid = null;
  state.port = null;
}
