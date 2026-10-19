import type { HerdrInputDelivery } from "./herdr-input";

export type HerdrUiStatus =
  | "working"
  | "waiting"
  | "blocked"
  | "idle"
  | "done"
  | "unknown";

export type HerdrSessionStatus = { status: HerdrUiStatus; alive: boolean; paneId: string };

/** Navigation owns sessions; fleet data supplies only status, never extra leaves. */
export function buildHerdrSessionStatusMap(fleet: HerdrFleetResponse | null, hooks: HerdrHookRecord[], error: string | null = null): Map<string, HerdrSessionStatus> {
  const map = new Map<string, HerdrSessionStatus>();
  for (const binding of fleet?.sessions ?? []) {
    map.set(binding.trellisSessionId ?? binding.sessionId, { status: "unknown", alive: false, paneId: binding.paneId });
  }
  for (const workspace of buildHerdrWorkspaceViews(fleet, hooks)) {
    for (const pane of workspace.panes) {
      const id = pane.binding?.trellisSessionId ?? pane.binding?.sessionId;
      if (id) map.set(id, { status: pane.status, alive: Boolean(!error && fleet?.available && pane.binding?.alive), paneId: pane.paneId });
    }
  }
  return map;
}

// Live bindings also protect previously attached CLI sessions whose origin
// has not been promoted yet. Closed Herdr mirrors retain their reopen UI.
export function isHerdrSession(
  session: { id: string; origin?: string; herdrAlive?: boolean } | null,
  fleet?: HerdrFleetResponse | null,
): boolean {
  if (!session) return false;
  const alive = fleet ? fleet.sessions.some(binding => bindingMatchesSession(binding, session.id) && binding.alive) : session.herdrAlive;
  return session.origin === "herdr" || !!alive;
}

export type HerdrHookRecord = {
  sessionId: string;
  agent?: "claude";
  state: "working" | "blocked" | "waiting" | "done";
  toolName: string | null;
  interactivePrompt: unknown;
  paneKey: string | null;
  updatedAt: number;
};

export type HerdrSessionBinding = {
  sessionId: string;
  trellisSessionId?: string;
  agentKind: string;
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  label: string | null;
  agentName: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  agentStatus: string;
  revision: number;
  alive: boolean;
  lastSeenAt?: number;
};

export type HerdrFleetPane = {
  pane_id: string;
  terminal_id: string;
  focused: boolean;
  agent: string | null;
  agent_status: string;
  cwd: string | null;
  label: string | null;
  terminal_title: string | null;
  revision: number;
  /** herdr 上报的当前 agent 会话（同一窗格可能先后跑过多个会话，绑定表里会有多行）。 */
  agent_session?: { value?: string | null } | null;
  /** 服务端从 jsonl 尾部认出的待答（仅 blocked 的 claude 窗格），见 transcript-pending.ts */
  transcript_prompt?: HerdrTranscriptPrompt | null;
  /** claude 窗格当前模型（jsonl 最近一条 assistant 的 message.model），读不到为 null */
  model?: string | null;
};

/** jsonl 里未完成的 tool_use 派生出的待答卡；interactivePrompt 与 hook 路径同形状。 */
export type HerdrTranscriptPrompt = {
  toolUseId: string;
  toolName: string;
  interactivePrompt: unknown;
};

export type HerdrFleetTab = {
  tab_id: string;
  label?: string | null;
  panes: HerdrFleetPane[];
};

export type HerdrFleetWorkspace = {
  workspace_id: string;
  worktree?: HerdrWorktree | null;
  label?: string | null;
  name?: string | null;
  /** herdr 自己的工作区编号（侧栏 1、2、3…），同名工作区靠它区分。 */
  number?: number | null;
  tabs: HerdrFleetTab[];
};

export type HerdrWorktree = {
  repo_root: string;
  repo_name: string;
  checkout_path: string;
  is_linked_worktree: boolean;
  git_branch?: string | null;
};

export function normalizeHerdrPath(value: string): string {
  return value.replace(/\/+$/, "") || (value.startsWith("/") ? "/" : value);
}

export type HerdrFleetResponse = {
  inputDeliveries?: HerdrInputDelivery[];
  available: boolean;
  enabled: boolean;
  realtime: boolean;
  readOnly: boolean;
  protocol: number | null;
  version: string | null;
  lastError: string | null;
  workspaces: HerdrFleetWorkspace[];
  sessions: HerdrSessionBinding[];
};

export type HerdrPaneView = {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  label: string;
  agentKind: string;
  agentName: string | null;
  status: HerdrUiStatus;
  alive: boolean;
  pane: HerdrFleetPane;
  binding: HerdrSessionBinding | null;
  hook: HerdrHookRecord | null;
  /** hook 缺席时的第二数据源（窗格 blocked 且 jsonl 有未完成的 tool_use） */
  transcript?: HerdrTranscriptPrompt | null;
};

/** 「需要你」的结构化数据：hook > transcript；都没有 → null（卡片退回读屏）。 */
export type HerdrPanePrompt = {
  source: "hook" | "transcript";
  prompt: unknown;
  toolName: string | null;
  toolUseId: string | null;
};

function isCardPrompt(prompt: unknown): boolean {
  if (!prompt || typeof prompt !== "object") return false;
  const record = prompt as Record<string, unknown>;
  const isAsk =
    record.tool_name === "AskUserQuestion" ||
    (record.approval as { tool?: string } | undefined)?.tool === "AskUserQuestion";
  if (isAsk) {
    return Array.isArray(record.questions) && record.questions.length > 0;
  }
  return (Array.isArray(record.questions) && record.questions.length > 0) ||
    Boolean(record.approval && typeof record.approval === "object");
}

export function herdrPanePrompt(pane: Pick<HerdrPaneView, "hook" | "transcript"> | null | undefined): HerdrPanePrompt | null {
  const hookPrompt = pane?.hook?.interactivePrompt;
  if (isCardPrompt(hookPrompt)) {
    const owner = hookPrompt as Record<string, unknown>;
    return {
      source: "hook",
      prompt: hookPrompt,
      toolName: pane?.hook?.toolName ?? null,
      toolUseId: typeof owner.tool_use_id === "string" ? owner.tool_use_id : null,
    };
  }
  const transcript = pane?.transcript;
  if (transcript && isCardPrompt(transcript.interactivePrompt)) {
    return { source: "transcript", prompt: transcript.interactivePrompt, toolName: transcript.toolName, toolUseId: transcript.toolUseId };
  }
  return null;
}

export type HerdrWorkspaceView = {
  id: string;
  label: string;
  worktree?: HerdrWorktree | null;
  panes: HerdrPaneView[];
};

/**
 * Herdr 镜像会话最后一轮的运行态文案；null = 没在跑（按 jsonl 快照的完成态渲染）。
 * 镜像节点在库里恒为 done，真实运行态只有窗格状态（herdr 自己的探测 + hook 的 waiting）
 * 知道。窗格离线一律 null —— 进程都没了，不能把最后一轮挂成「生成中」。
 * hook 的 toolName 在工具结束后不清（normalize.ts 只在 Stop / 新一轮清），所以只说
 * 「最近一步」，不说「正在运行」，免得工具早跑完了还挂着。
 */
export function herdrRunLabel(pane: HerdrPaneView | null): string | null {
  if (!pane?.alive) return null;
  if (pane.status === "waiting" || pane.status === "blocked") {
    const tool = herdrPanePrompt(pane)?.toolName ?? pane.hook?.toolName;
    return tool === "AskUserQuestion" ? "等待你回答" : "等待你批准";
  }
  if (pane.status !== "working") return null;
  const tool = pane.hook?.state === "working" ? pane.hook.toolName : null;
  return tool ? `正在工作 · 最近一步 ${tool}` : "正在生成";
}

export const HERDR_HOOK_TTL_MS = 5 * 60_000;

function freshHook(hook: HerdrHookRecord | null | undefined, now: number): HerdrHookRecord | null {
  return hook && now - hook.updatedAt < HERDR_HOOK_TTL_MS ? hook : null;
}

/** hook 报 waiting，或窗格 blocked 且 transcript 认出了待答卡 → waiting（结构化卡片，不读屏）。 */
function liveStatus(hook: HerdrHookRecord | null, status: string, transcript?: HerdrTranscriptPrompt | null): HerdrUiStatus {
  if (hook?.state === "waiting") return "waiting";
  if (transcript && status === "blocked") return "waiting";
  return paneStatus(status);
}

const KNOWN_STATUSES = new Set<HerdrUiStatus>([
  "working",
  "waiting",
  "blocked",
  "idle",
  "done",
  "unknown",
]);

function paneStatus(value: string): HerdrUiStatus {
  return KNOWN_STATUSES.has(value as HerdrUiStatus)
    ? (value as HerdrUiStatus)
    : "unknown";
}

function comparePanes(a: HerdrPaneView, b: HerdrPaneView): number {
  return a.label.localeCompare(b.label) || (a.pane.cwd ?? "").localeCompare(b.pane.cwd ?? "") || a.paneId.localeCompare(b.paneId);
}

function workspaceLabel(workspace: HerdrFleetWorkspace): string {
  return (
    workspace.label?.trim() ||
    workspace.name?.trim() ||
    workspace.workspace_id
  );
}

export function buildHerdrWorkspaceViews(
  fleet: HerdrFleetResponse | null,
  hooks: HerdrHookRecord[],
  now = Date.now(),
): HerdrWorkspaceView[] {
  if (!fleet) return [];
  // 同一窗格先后跑过的会话都留在绑定表里：优先取 herdr 报告的当前 agent 会话，
  // 报告缺席时沿用旧规则（列表里最后一条）。
  const bindingsByPane = new Map<string, HerdrSessionBinding[]>();
  for (const binding of fleet.sessions) {
    const list = bindingsByPane.get(binding.paneId);
    if (list) list.push(binding);
    else bindingsByPane.set(binding.paneId, [binding]);
  }
  const bindingFor = (pane: HerdrFleetPane): HerdrSessionBinding | null => {
    const list = bindingsByPane.get(pane.pane_id);
    if (!list) return null;
    const current = pane.agent_session?.value;
    return (current && list.find((binding) => binding.sessionId === current)) || list[list.length - 1];
  };
  const hookBySession = new Map(hooks.map((hook) => [hook.sessionId, hook]));
  // 同一窗格可能留有多条 hook 记录（换过会话）：取最新那条，不依赖列表顺序。
  const hookByPane = new Map<string, (typeof hooks)[number]>();
  for (const hook of hooks) {
    if (!hook.paneKey) continue;
    const prev = hookByPane.get(hook.paneKey);
    if (!prev || hook.updatedAt > prev.updatedAt) hookByPane.set(hook.paneKey, hook);
  }

  return fleet.workspaces
    .map((workspace) => {
      const label = workspaceLabel(workspace);
      const panes = workspace.tabs
        .flatMap((tab) => tab.panes)
        .filter((pane) => Boolean(pane.agent))
        .map((pane): HerdrPaneView => {
          const binding = bindingFor(pane);
          const hook = freshHook(
            binding ? hookBySession.get(binding.sessionId) : hookByPane.get(pane.pane_id),
            now,
          );
          const agentKind = pane.agent ?? binding?.agentKind ?? "unknown";
          return {
            paneId: pane.pane_id,
            workspaceId: workspace.workspace_id,
            workspaceLabel: label,
            label:
              pane.label?.trim() ||
              binding?.label?.trim() ||
              binding?.agentName?.trim() ||
              agentKind,
            agentKind,
            agentName: binding?.agentName ?? null,
            status: liveStatus(hook, pane.agent_status, pane.transcript_prompt),
            alive: fleet.available && (binding?.alive ?? true),
            pane,
            binding,
            hook,
            transcript: pane.agent_status === "blocked" ? pane.transcript_prompt ?? null : null,
          };
        })
        .sort(comparePanes);
      return { id: workspace.workspace_id, label, panes, worktree: workspace.worktree };
    })
    .filter((workspace) => workspace.panes.length > 0)
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );
}

export function groupHerdrWorkspaces(workspaces: HerdrWorkspaceView[]) {
  const repositories = new Map<string, {
    id: string; label: string; attention: number;
    worktrees: { id: string; label: string; title: string; isLinked: boolean; attention: number; panes: HerdrPaneView[] }[];
  }>();
  const ungrouped: HerdrWorkspaceView[] = [];
  for (const workspace of workspaces) {
    const metadata = workspace.worktree;
    const wt = metadata && { ...metadata, repo_root: normalizeHerdrPath(metadata.repo_root), checkout_path: normalizeHerdrPath(metadata.checkout_path) };
    if (!wt?.repo_root || !wt.checkout_path) { ungrouped.push(workspace); continue; }
    let repo = repositories.get(wt.repo_root);
    if (!repo) {
      repo = { id: wt.repo_root, label: wt.repo_name, attention: 0, worktrees: [] };
      repositories.set(repo.id, repo);
    }
    const attention = workspace.panes.filter(p => p.status === "waiting" || p.status === "blocked").length;
    repo.attention += attention;
    const existing = repo.worktrees.find(w => w.id === wt.checkout_path);
    if (existing) {
      existing.panes.push(...workspace.panes);
      existing.attention += attention;
      existing.title += `\n${workspace.label}`;
    } else repo.worktrees.push({
      id: wt.checkout_path,
      isLinked: wt.is_linked_worktree,
      label: wt.git_branch && wt.git_branch !== "HEAD" ? wt.git_branch : "未知分支",
      title: `${workspace.label}\n${wt.checkout_path}`,
      attention, panes: [...workspace.panes],
    });
  }
  for (const repo of repositories.values()) {
    repo.worktrees.sort((a, b) => Number(a.isLinked) - Number(b.isLinked) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    for (const wt of repo.worktrees) wt.panes.sort(comparePanes);
  }
  return {
    repositories: [...repositories.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    ungrouped: ungrouped.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
  };
}

function bindingMatchesSession(binding: HerdrSessionBinding, sessionId: string): boolean {
  return binding.sessionId === sessionId || binding.trellisSessionId === sessionId;
}

export function findHerdrPaneForSession(
  fleet: HerdrFleetResponse | null,
  hooks: HerdrHookRecord[],
  workspaces: HerdrWorkspaceView[],
  sessionId: string | null | undefined,
  now = Date.now(),
): HerdrPaneView | null {
  if (!sessionId) return null;
  for (const workspace of workspaces) {
    const pane = workspace.panes.find(
      (candidate) => candidate.binding && bindingMatchesSession(candidate.binding, sessionId),
    );
    if (pane) return pane;
  }
  const binding = fleet?.sessions.find(
    (candidate) => bindingMatchesSession(candidate, sessionId),
  );
  if (!binding) return null;
  const workspace = fleet?.workspaces.find(
    (candidate) => candidate.workspace_id === binding.workspaceId,
  );
  const hook = freshHook(
    hooks.find(
      (candidate) =>
        candidate.sessionId === binding.sessionId,
    ), now);
  const label = workspace ? workspaceLabel(workspace) : binding.workspaceId;
  return {
    paneId: binding.paneId,
    workspaceId: binding.workspaceId,
    workspaceLabel: label,
    label: binding.label || binding.agentName || binding.agentKind,
    agentKind: binding.agentKind,
    agentName: binding.agentName,
    status: liveStatus(hook, binding.agentStatus),
    alive: Boolean(fleet?.available && binding.alive),
    pane: {
      pane_id: binding.paneId,
      terminal_id: binding.terminalId,
      focused: false,
      agent: binding.agentKind,
      agent_status: binding.agentStatus,
      cwd: binding.cwd,
      label: binding.label,
      terminal_title: null,
      revision: binding.revision,
    },
    binding,
    hook,
  };
}
