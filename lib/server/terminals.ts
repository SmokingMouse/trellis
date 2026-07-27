import "server-only";
import { spawnSync } from "node:child_process";
import { tmuxBin } from "./ttyd";

// S1 P1：workspace 的终端列表。
//
// **终端列表不入 DB —— tmux 本身就是真源。**
// 好处：零 schema、trellis 重启后自动恢复、与用户在 CLI 里手开的 session
// 天然一致，且不存在「DB 说有 3 个但 tmux 里只剩 1 个」的漂移。
//
// 命名 `ws-<workspace-id>-<n>`。workspace id 是 uuid（含 `-`），所以解析序号
// 要从**右边**切最后一段，不能按 `-` split。

const PREFIX = "ws-";

export type Terminal = {
  /** tmux session 名，直接拼进 ttyd 的 ?arg= */
  session: string;
  /** 序号，UI 显示成「bash 1」 */
  index: number;
};

function tmux(args: string[]): { ok: boolean; out: string } {
  const bin = tmuxBin();
  if (!bin) return { ok: false, out: "" };
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
  // 没有任何 session 时 tmux 以非 0 退出并打印 "no server running..."，
  // 那是正常状态不是错误。
  return { ok: !r.error && r.status === 0, out: (r.stdout ?? "").trim() };
}

function sessionPrefix(workspaceId: string): string {
  return `${PREFIX}${workspaceId}-`;
}

/**
 * 列出某个 workspace 名下的终端，按序号升序。
 *
 * 用 `list-sessions -F` 而不是裸 `tmux ls` —— 后者的输出格式是给人看的
 * （"name: 1 windows (created ...)"），解析脆。
 */
export function listTerminals(workspaceId: string): Terminal[] {
  const { ok, out } = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!ok || !out) return [];
  const pre = sessionPrefix(workspaceId);
  const list: Terminal[] = [];
  for (const name of out.split("\n")) {
    const s = name.trim();
    if (!s.startsWith(pre)) continue;
    const n = Number(s.slice(pre.length));
    if (!Number.isInteger(n) || n < 1) continue;
    list.push({ session: s, index: n });
  }
  return list.sort((a, b) => a.index - b.index);
}

/**
 * 分配一个新终端的 session 名。
 *
 * 这里**不创建** tmux session —— ttyd 那条命令是 `tmux new -A -s <name>`，
 * 浏览器一连上来 tmux 自己就会建。服务端先建反而会撞上「谁先谁后」的竞态，
 * 也会造出一个没人连的空 session。
 *
 * 序号取「当前最大 + 1」而不是「数量 + 1」，是为了**不与活着的 session 撞名**。
 * count+1 在序号有空洞时会撞：留着 #1 #2、杀掉 #1，count+1 = 2 正好是活的那个，
 * 而 ttyd 的命令是 `tmux new -A -s`，遇到同名会 **attach 到已有 session** ——
 * 用户点「+」拿到的是现有终端的副本，不是新终端。（实测：造出该空洞后
 * max+1 给出 3，count+1 会给 2。）
 *
 * 复用已死的序号本身无害，也不刻意避免：关掉最大号那个再开，确实会拿回同一个号。
 */
export function nextTerminalSession(workspaceId: string): string {
  const max = listTerminals(workspaceId).reduce((m, t) => Math.max(m, t.index), 0);
  return `${sessionPrefix(workspaceId)}${max + 1}`;
}

export function killTerminal(session: string): boolean {
  if (!session.startsWith(PREFIX)) return false; // 只准杀自己命名空间里的
  return tmux(["kill-session", "-t", session]).ok;
}

/**
 * 干掉某个 workspace 名下的全部终端。
 *
 * workspace 被移除 / 删除时必须调用 —— 否则 tmux 里会堆一地指向已消失目录的
 * 孤儿 session，而 tmux 是终端列表的真源，脏了就一直脏。
 */
export function killWorkspaceTerminals(workspaceId: string): number {
  let n = 0;
  for (const t of listTerminals(workspaceId)) {
    if (killTerminal(t.session)) n++;
  }
  return n;
}
