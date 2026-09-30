// 对话 / Herdr 两个模式的纯派生层（2026-09-30 用户拍板，推翻 sidebar-tree-ia.md
// 「Herdr 并进项目树」旧决策）：
//   对话模式  侧栏项目树 / 置顶区 / 标签行都不出现 Herdr 会话；
//   Herdr 模式 侧栏按 Herdr 自己的结构排（workspace → 窗格），标签行整行换成分组窗格条。
// 模式不是独立开关，而是当前视图的投影：开着 Herdr 会话或 /herdr 总览 = Herdr 模式，
// 其余（普通会话 / 首页 / 草稿）= 对话模式。所以从 ⌥K、通知、URL 任何途径打开 Herdr
// 会话都会自动切过去，不需要各入口各自记得切。本地偏好只用来让刷新落回上次的模式。
//
// 这里只有纯函数（单测见 lib/herdr-mode.test.ts）；组件只负责渲染。
import { cleanTerminalTitle, type HerdrConsolePane } from "./herdr-console";
import { isHerdrSession, type HerdrFleetResponse, type HerdrFleetWorkspace } from "./herdr-ui";

export type AppMode = "chat" | "herdr";

export function parseAppMode(raw: string | null | undefined): AppMode {
  return raw === "herdr" ? "herdr" : "chat";
}

/** 当前视图属于哪个模式：Herdr 会话 / 总览 → herdr，其余 → chat。 */
export function appModeFor(
  view: { session: { id: string; origin?: string; herdrAlive?: boolean } | null; herdrOpen: boolean },
  fleet?: HerdrFleetResponse | null,
): AppMode {
  if (view.session) return isHerdrSession(view.session, fleet) ? "herdr" : "chat";
  return view.herdrOpen ? "herdr" : "chat";
}

// ── 行标题 ──────────────────────────────────────────────────────────────

// agent / shell 启动时的默认终端标题：不带任务信息，当标题用等于满屏「Claude Code」。
const DEFAULT_TITLES = new Set([
  "claude code",
  "claude",
  "codex",
  "openai codex",
  "gemini",
  "gemini cli",
  "opencode",
  "amp",
  "cursor agent",
  "zsh",
  "bash",
  "fish",
  "sh",
  "node",
]);

export function isDefaultTerminalTitle(title: string, agentKind?: string | null): boolean {
  const t = title.trim().toLowerCase();
  if (!t) return true;
  if (DEFAULT_TITLES.has(t)) return true;
  if (agentKind && t === agentKind.trim().toLowerCase()) return true;
  // 纯 shell 的 user@host:path
  return /^[^@\s]+@[^:\s]+:/.test(title.trim());
}

export function basename(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** 行标题：pane label > 终端标题（去前缀符号、跳过默认标题）> 绑定会话标题 > cwd basename。 */
export function herdrRowTitle(input: {
  label?: string | null;
  terminalTitle?: string | null;
  sessionTitle?: string | null;
  cwd?: string | null;
  agentKind?: string | null;
}): string {
  const label = input.label?.trim();
  if (label) return label;
  const terminal = cleanTerminalTitle(input.terminalTitle);
  if (terminal && !isDefaultTerminalTitle(terminal, input.agentKind)) return terminal;
  const session = input.sessionTitle?.trim();
  if (session) return session;
  return basename(input.cwd) || input.agentKind || "窗格";
}

/** ~/code/agent/harbor → …/agent/harbor；~/.claude → ~/.claude。只给同名工作区做区分。 */
export function shortPath(path: string | null | undefined, home?: string | null): string {
  if (!path) return "";
  let p = path.replace(/\/+$/, "");
  const h = home ?? /^\/Users\/[^/]+|^\/home\/[^/]+/.exec(p)?.[0];
  if (h && (p === h || p.startsWith(`${h}/`))) p = `~${p.slice(h.length)}`;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p || "/";
  return `…/${parts.slice(-2).join("/")}`;
}

// ── 分组 ────────────────────────────────────────────────────────────────

export type HerdrModeRow = {
  pane: HerdrConsolePane;
  title: string;
  /** 纯 shell 窗格：弱化显示在组末，不进窗格条与 ⌥ 编号 */
  shell: boolean;
};

export type HerdrModeGroup = {
  id: string;
  label: string;
  /** 同名工作区的区分后缀（分支 / 短路径 / #编号）；不撞名为 null */
  hint: string | null;
  /** 分支：linked worktree 总是带；主 checkout 只在不是 main / master 时带 */
  branch: string | null;
  number: number | null;
  path: string | null;
  need: number;
  run: number;
  activityAt: number | null;
  /** agent 窗格，按 Herdr 自己的 tab → 窗格顺序 */
  rows: HerdrModeRow[];
  shells: HerdrModeRow[];
};

function workspaceLabel(w: HerdrFleetWorkspace): string {
  return w.label?.trim() || w.name?.trim() || w.workspace_id;
}

function workspaceBranch(w: HerdrFleetWorkspace): string | null {
  const wt = w.worktree;
  const branch = wt?.git_branch?.trim();
  if (!wt || !branch || branch === "HEAD") return null;
  if (wt.is_linked_worktree) return branch;
  return branch === "main" || branch === "master" ? null : branch;
}

/**
 * Herdr 模式的侧栏 / 窗格条共用分组。
 * 组序：含需要你 → 含在跑 → 最近活动（hook 时间）→ Herdr 编号。
 * 组内：Herdr 的 tab → 窗格顺序（稳定，⌥1-9 不会因状态抖动乱跳），纯 shell 另列组末。
 * 离线会话（lane=off）不进分组 —— 总览里有「已离线」泳道。
 */
export function buildHerdrModeGroups(
  fleet: HerdrFleetResponse | null,
  panes: HerdrConsolePane[],
  sessionTitle: (sessionId: string) => string | null | undefined = () => null,
  home?: string | null,
): HerdrModeGroup[] {
  if (!fleet) return [];
  const byPane = new Map(panes.filter((p) => p.lane !== "off").map((p) => [p.paneId, p]));
  const groups: HerdrModeGroup[] = [];
  fleet.workspaces.forEach((w) => {
    const rows: HerdrModeRow[] = [];
    const shells: HerdrModeRow[] = [];
    let need = 0;
    let run = 0;
    let activityAt: number | null = null;
    let firstCwd: string | null = null;
    for (const tab of w.tabs) {
      for (const fp of tab.panes) {
        const pane = byPane.get(fp.pane_id);
        if (!pane) continue;
        firstCwd ??= fp.cwd;
        if (pane.lane === "shell") {
          shells.push({
            pane,
            shell: true,
            title: fp.label?.trim() || pane.title,
          });
          continue;
        }
        if (pane.lane === "need") need++;
        if (pane.lane === "run") run++;
        if (pane.activityAt != null && (activityAt == null || pane.activityAt > activityAt)) activityAt = pane.activityAt;
        rows.push({
          pane,
          shell: false,
          title: herdrRowTitle({
            label: fp.label,
            terminalTitle: fp.terminal_title,
            sessionTitle: pane.sessionId ? sessionTitle(pane.sessionId) : null,
            cwd: fp.cwd,
            agentKind: pane.agentKind,
          }),
        });
      }
    }
    if (!rows.length && !shells.length) return;
    groups.push({
      id: w.workspace_id,
      label: workspaceLabel(w),
      hint: null,
      branch: workspaceBranch(w),
      number: typeof w.number === "number" ? w.number : null,
      path: w.worktree?.checkout_path ?? firstCwd,
      need,
      run,
      activityAt,
      rows,
      shells,
    });
  });

  // 同名工作区（多个 `.claude`）：依次试 分支 → 短路径 → #编号，取第一个能在撞名组里唯一的。
  const byLabel = new Map<string, HerdrModeGroup[]>();
  for (const g of groups) {
    const list = byLabel.get(g.label);
    if (list) list.push(g);
    else byLabel.set(g.label, [g]);
  }
  for (const list of byLabel.values()) {
    if (list.length < 2) continue;
    const candidates: ((g: HerdrModeGroup) => string | null)[] = [
      (g) => g.branch,
      (g) => (g.path ? shortPath(g.path, home) : null),
      (g) => (g.number != null ? `#${g.number}` : `#${g.id}`),
    ];
    for (const g of list) {
      for (const pick of candidates) {
        const value = pick(g);
        if (value && list.filter((other) => pick(other) === value).length === 1) {
          g.hint = value;
          break;
        }
      }
      g.hint ??= g.number != null ? `#${g.number}` : `#${g.id}`;
    }
  }

  return groups.sort(compareGroups);
}

function compareGroups(a: HerdrModeGroup, b: HerdrModeGroup): number {
  const rank = (g: HerdrModeGroup) => (g.need > 0 ? 0 : g.run > 0 ? 1 : 2);
  const r = rank(a) - rank(b);
  if (r) return r;
  if (a.activityAt !== b.activityAt) {
    if (a.activityAt == null) return 1;
    if (b.activityAt == null) return -1;
    return b.activityAt - a.activityAt;
  }
  const an = a.number ?? Number.MAX_SAFE_INTEGER;
  const bn = b.number ?? Number.MAX_SAFE_INTEGER;
  return an - bn || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

/** 窗格条 / ⌥1-9 / ⌥[ ⌥] / ⌥J 的顺序：按组序展开各组的 agent 窗格（不含 shell）。 */
export function herdrModeStrip(groups: HerdrModeGroup[]): HerdrConsolePane[] {
  return groups.flatMap((g) => g.rows.map((r) => r.pane));
}

/** 组名 + 区分后缀，给提示 / 读屏用。 */
export function herdrGroupName(g: Pick<HerdrModeGroup, "label" | "hint">): string {
  return g.hint ? `${g.label} ${g.hint}` : g.label;
}
