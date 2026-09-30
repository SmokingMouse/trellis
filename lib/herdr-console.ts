// Herdr 操作台（/herdr 总览 · 会话页窗格切换条 · 跨窗格通知 · 跳转面板）的纯派生层。
// 输入只有 fleet 快照 + hook 镜像，不发请求、不碰 DOM —— 排序、泳道、通知去重都在
// 这里定稿并单测（lib/herdr-console.test.ts），组件只负责渲染。
//
// 泳道口径（原型 docs/ui-redesign/mockups/05-herdr.html）：
//   need  = waiting / blocked（hook 镜像补的 waiting 已由 buildHerdrWorkspaceViews 合并）
//   run   = working
//   idle  = idle / done / unknown
//   off   = 绑定表里已离线的会话（按归档处理，默认折叠）
//   shell = 没有 agent 的纯 shell 窗格（默认折叠）
import {
  buildHerdrWorkspaceViews,
  type HerdrFleetResponse,
  type HerdrHookRecord,
  type HerdrPaneView,
  type HerdrSessionBinding,
  type HerdrUiStatus,
} from "./herdr-ui";

export type HerdrLane = "need" | "run" | "idle" | "off" | "shell";

export type HerdrConsolePane = {
  /** 稳定键：活窗格 = paneId；离线会话 = `off:<sessionId>` */
  key: string;
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  tabLabel: string;
  title: string;
  lane: HerdrLane;
  status: HerdrUiStatus | null;
  agentKind: string | null;
  /** 点卡片要打开的 Trellis 会话；纯 shell / 无绑定为 null */
  sessionId: string | null;
  view: HerdrPaneView | null;
  lastTool: string | null;
  /** 最近一次 hook 事件（或离线时最后一次看到）的时间；未知为 null */
  activityAt: number | null;
  queued: number;
  focused: boolean;
  cwd: string | null;
};

export const HERDR_LANE_LABEL: Record<HerdrLane, string> = {
  need: "需要你",
  run: "在跑",
  idle: "空闲",
  off: "已离线",
  shell: "shell",
};

export const HERDR_OFFLINE_LIMIT = 20;

export function laneOfStatus(status: HerdrUiStatus): HerdrLane {
  if (status === "waiting" || status === "blocked") return "need";
  if (status === "working") return "run";
  return "idle";
}

// Claude Code 把旋转 spinner 放在终端标题最前（✳ / ✻ / ⠂ …），标题本身是任务名。
const TITLE_GLYPHS = /^[\s⠀-⣿✠-❏●○◐-◓⏺·*•·]+/u;

export function cleanTerminalTitle(title: string | null | undefined): string {
  return (title ?? "").replace(TITLE_GLYPHS, "").trim();
}

/** 纯 shell 的标题形如 user@host:~/repo —— 只留路径。 */
export function shellTitle(title: string | null | undefined, cwd: string | null): string {
  const cleaned = cleanTerminalTitle(title).replace(/^[^@\s]+@[^:\s]+:\s*/, "");
  return cleaned || cwd || "shell";
}

export function tabLabelOf(tab: { tab_id: string; label?: string | null }): string {
  const label = tab.label?.trim();
  if (label && !/^\d+$/.test(label)) return label;
  if (label) return `t${label}`;
  const suffix = tab.tab_id.split(":").pop() ?? tab.tab_id;
  return suffix;
}

function basename(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function bindingSessionId(binding: HerdrSessionBinding | null | undefined): string | null {
  if (!binding) return null;
  return binding.trellisSessionId ?? binding.sessionId;
}

export function buildHerdrConsole(
  fleet: HerdrFleetResponse | null,
  hooks: HerdrHookRecord[],
  now = Date.now(),
): HerdrConsolePane[] {
  if (!fleet) return [];
  const views = new Map<string, HerdrPaneView>();
  for (const workspace of buildHerdrWorkspaceViews(fleet, hooks, now)) {
    for (const pane of workspace.panes) views.set(pane.paneId, pane);
  }
  const queuedByPane = new Map<string, number>();
  for (const delivery of fleet.inputDeliveries ?? []) {
    if (delivery.status !== "queued") continue;
    queuedByPane.set(delivery.paneId, (queuedByPane.get(delivery.paneId) ?? 0) + 1);
  }

  const out: HerdrConsolePane[] = [];
  const liveSessions = new Set<string>();
  const tabLabels = new Map<string, string>();
  for (const workspace of fleet.workspaces) {
    const workspaceLabel = workspace.label?.trim() || workspace.name?.trim() || workspace.workspace_id;
    for (const tab of workspace.tabs) {
      const tabLabel = tabLabelOf(tab);
      tabLabels.set(tab.tab_id, tabLabel);
      for (const pane of tab.panes) {
        const base = {
          key: pane.pane_id,
          paneId: pane.pane_id,
          workspaceId: workspace.workspace_id,
          workspaceLabel,
          tabId: tab.tab_id,
          tabLabel,
          queued: queuedByPane.get(pane.pane_id) ?? 0,
          focused: pane.focused,
          cwd: pane.cwd,
        };
        const view = pane.agent ? views.get(pane.pane_id) ?? null : null;
        if (!view) {
          out.push({
            ...base,
            title: shellTitle(pane.terminal_title, pane.cwd),
            lane: "shell",
            status: null,
            agentKind: null,
            sessionId: null,
            view: null,
            lastTool: null,
            activityAt: null,
          });
          continue;
        }
        const sessionId = view.binding?.alive === false ? null : bindingSessionId(view.binding);
        if (sessionId) liveSessions.add(sessionId);
        if (view.binding) liveSessions.add(view.binding.sessionId);
        out.push({
          ...base,
          title: cleanTerminalTitle(pane.terminal_title) || view.label || workspaceLabel,
          lane: laneOfStatus(view.status),
          status: view.status,
          agentKind: view.agentKind,
          sessionId,
          view,
          lastTool: view.hook?.toolName ?? null,
          activityAt: view.hook?.updatedAt ?? null,
        });
      }
    }
  }

  const workspaceLabels = new Map(
    fleet.workspaces.map((w) => [w.workspace_id, w.label?.trim() || w.name?.trim() || w.workspace_id]),
  );
  const seenOffline = new Set<string>();
  let offline = 0;
  for (const binding of fleet.sessions) {
    if (binding.alive || offline >= HERDR_OFFLINE_LIMIT) continue;
    const sessionId = bindingSessionId(binding)!;
    if (liveSessions.has(sessionId) || liveSessions.has(binding.sessionId) || seenOffline.has(sessionId)) continue;
    seenOffline.add(sessionId);
    offline++;
    out.push({
      key: `off:${sessionId}`,
      paneId: binding.paneId,
      workspaceId: binding.workspaceId,
      workspaceLabel: workspaceLabels.get(binding.workspaceId) ?? (basename(binding.cwd) || binding.workspaceId),
      tabId: binding.tabId,
      tabLabel: tabLabels.get(binding.tabId) ?? tabLabelOf({ tab_id: binding.tabId }),
      title: binding.label?.trim() || binding.agentName?.trim() || basename(binding.cwd) || binding.agentKind,
      lane: "off",
      status: null,
      agentKind: binding.agentKind,
      sessionId,
      view: null,
      lastTool: null,
      activityAt: binding.lastSeenAt ?? null,
      queued: 0,
      focused: false,
      cwd: binding.cwd,
    });
  }
  return out;
}

function stableCompare(a: HerdrConsolePane, b: HerdrConsolePane): number {
  return (
    a.workspaceLabel.localeCompare(b.workspaceLabel) ||
    a.tabLabel.localeCompare(b.tabLabel, undefined, { numeric: true }) ||
    a.key.localeCompare(b.key)
  );
}

/** 未知时间排最后；asc = 越早越前（等得最久的先处理）。 */
function byActivity(dir: "asc" | "desc") {
  return (a: HerdrConsolePane, b: HerdrConsolePane) => {
    if (a.activityAt == null && b.activityAt == null) return stableCompare(a, b);
    if (a.activityAt == null) return 1;
    if (b.activityAt == null) return -1;
    const diff = dir === "asc" ? a.activityAt - b.activityAt : b.activityAt - a.activityAt;
    return diff || stableCompare(a, b);
  };
}

export type HerdrLanes = {
  need: HerdrConsolePane[];
  run: HerdrConsolePane[];
  idle: HerdrConsolePane[];
  off: HerdrConsolePane[];
  shell: HerdrConsolePane[];
};

export function groupHerdrLanes(panes: HerdrConsolePane[]): HerdrLanes {
  const lanes: HerdrLanes = { need: [], run: [], idle: [], off: [], shell: [] };
  for (const pane of panes) lanes[pane.lane].push(pane);
  lanes.need.sort(byActivity("asc"));
  lanes.run.sort(stableCompare);
  lanes.idle.sort(byActivity("desc"));
  lanes.off.sort(byActivity("desc"));
  lanes.shell.sort(stableCompare);
  return lanes;
}

/** 切换条 / ⌥1-9：活着的 agent 窗格，需要你 → 在跑 → 空闲。 */
export function herdrStripPanes(panes: HerdrConsolePane[]): HerdrConsolePane[] {
  const lanes = groupHerdrLanes(panes);
  return [...lanes.need, ...lanes.run, ...lanes.idle];
}

/** 下一个需要你的窗格：按切换条顺序从当前之后找（环绕），不含当前。 */
export function nextNeedPane(strip: HerdrConsolePane[], currentKey: string | null): HerdrConsolePane | null {
  const start = currentKey ? strip.findIndex((p) => p.key === currentKey) : -1;
  for (let i = 1; i <= strip.length; i++) {
    const pane = strip[(start + i + strip.length) % strip.length];
    if (pane && pane.lane === "need" && pane.key !== currentKey) return pane;
  }
  return null;
}

/** ⌥[ / ⌥]：切换条上前后一格，不环绕；当前不在条上时从两端进入。 */
export function stepHerdrPane(strip: HerdrConsolePane[], currentKey: string | null, dir: 1 | -1): HerdrConsolePane | null {
  const i = currentKey ? strip.findIndex((p) => p.key === currentKey) : -1;
  if (i < 0) return (dir === 1 ? strip[0] : strip[strip.length - 1]) ?? null;
  return strip[i + dir] ?? null;
}

export function findConsolePaneForSession(panes: HerdrConsolePane[], sessionId: string | null | undefined): HerdrConsolePane | null {
  if (!sessionId) return null;
  return panes.find((p) => p.lane !== "off" && (p.sessionId === sessionId || p.view?.binding?.sessionId === sessionId)) ?? null;
}

export function matchHerdrPanes(panes: HerdrConsolePane[], query: string): HerdrConsolePane[] {
  const order: Record<HerdrLane, number> = { need: 0, run: 1, idle: 2, off: 3, shell: 4 };
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return panes
    .filter((p) => {
      if (!terms.length) return true;
      const hay = `${p.workspaceLabel} ${p.tabLabel} ${p.title} ${p.paneId}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => order[a.lane] - order[b.lane] || stableCompare(a, b));
}

// ── 待确认内容解析（HerdrInteractionCard 与通知卡共用） ──

export type HerdrAskOption = { label?: unknown; description?: unknown };
export type HerdrAskQuestion = { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };

export function herdrAskQuestions(prompt: unknown): HerdrAskQuestion[] {
  if (!prompt || typeof prompt !== "object" || !("questions" in prompt)) return [];
  const questions = (prompt as { questions?: unknown }).questions;
  return Array.isArray(questions) ? (questions as HerdrAskQuestion[]) : [];
}

export function herdrApproval(prompt: unknown): { tool: string; summary: string } | null {
  if (!prompt || typeof prompt !== "object" || !("approval" in prompt)) return null;
  const value = (prompt as { approval?: unknown }).approval;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    tool: typeof record.tool === "string" ? record.tool : "操作",
    summary: typeof record.summary === "string" ? record.summary : "",
  };
}

export function herdrAttentionKind(pane: HerdrConsolePane): "approval" | "question" | "terminal" {
  const prompt = pane.view?.hook?.interactivePrompt;
  if (herdrApproval(prompt)) return "approval";
  if (herdrAskQuestions(prompt).length) return "question";
  return "terminal";
}

/** 通知 / 卡片副标题一行话：要执行什么 / 问了什么。 */
export function herdrAttentionText(pane: HerdrConsolePane): string {
  const prompt = pane.view?.hook?.interactivePrompt;
  const approval = herdrApproval(prompt);
  if (approval) {
    const summary = approval.summary.split("\n")[0].trim();
    return summary ? `要执行 ${approval.tool}：${summary}` : `要执行 ${approval.tool}`;
  }
  const question = herdrAskQuestions(prompt)[0];
  if (question && typeof question.question === "string") return `提问：${question.question}`;
  if (pane.lastTool) return `等你处理 · 最近一步 ${pane.lastTool}`;
  return "终端在等你输入";
}

// ── 跨窗格通知：从状态变化派生，同一窗格同一次卡住只通知一次 ──

export type HerdrAttentionState = {
  lanes: Map<string, HerdrLane>;
  /** 离开 need 的时刻；短时间内回到 need 视为同一次卡住（hook TTL / 探测抖动） */
  leftNeedAt: Map<string, number>;
};

export const HERDR_ATTENTION_FLICKER_MS = 8_000;

export function diffHerdrAttention(
  prev: HerdrAttentionState | null,
  panes: HerdrConsolePane[],
  now = Date.now(),
): { state: HerdrAttentionState; raised: HerdrConsolePane[] } {
  const lanes = new Map<string, HerdrLane>();
  const leftNeedAt = new Map<string, number>();
  const raised: HerdrConsolePane[] = [];
  for (const pane of panes) {
    if (pane.lane === "off" || pane.lane === "shell") continue;
    lanes.set(pane.key, pane.lane);
    const before = prev?.lanes.get(pane.key);
    const left = prev?.leftNeedAt.get(pane.key);
    if (pane.lane === "need") {
      const flicker = left != null && now - left < HERDR_ATTENTION_FLICKER_MS;
      if (prev && before !== "need" && !flicker) raised.push(pane);
    } else if (before === "need") {
      leftNeedAt.set(pane.key, now);
    } else if (left != null && now - left < HERDR_ATTENTION_FLICKER_MS) {
      leftNeedAt.set(pane.key, left);
    }
  }
  return { state: { lanes, leftNeedAt }, raised };
}

export function herdrLaneCounts(panes: HerdrConsolePane[]): Record<HerdrLane, number> {
  const counts: Record<HerdrLane, number> = { need: 0, run: 0, idle: 0, off: 0, shell: 0 };
  for (const pane of panes) counts[pane.lane]++;
  return counts;
}
