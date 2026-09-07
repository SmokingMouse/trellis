export type HerdrUiStatus =
  | "working"
  | "waiting"
  | "blocked"
  | "idle"
  | "done"
  | "unknown";

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
};

export type HerdrFleetTab = {
  tab_id: string;
  label?: string | null;
  panes: HerdrFleetPane[];
};

export type HerdrFleetWorkspace = {
  workspace_id: string;
  label?: string | null;
  name?: string | null;
  tabs: HerdrFleetTab[];
};

export type HerdrFleetResponse = {
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
};

export type HerdrWorkspaceView = {
  id: string;
  label: string;
  panes: HerdrPaneView[];
};

export const HERDR_HOOK_TTL_MS = 5 * 60_000;

function freshHook(hook: HerdrHookRecord | null | undefined, now: number): HerdrHookRecord | null {
  return hook && now - hook.updatedAt < HERDR_HOOK_TTL_MS ? hook : null;
}

function liveStatus(hook: HerdrHookRecord | null, status: string): HerdrUiStatus {
  return hook?.state === "waiting" ? "waiting" : paneStatus(status);
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

function urgency(status: HerdrUiStatus): number {
  if (status === "waiting") return 0;
  if (status === "blocked") return 1;
  if (status === "working") return 2;
  return 3;
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
  const bindingByPane = new Map(
    fleet.sessions.map((binding) => [binding.paneId, binding]),
  );
  const hookBySession = new Map(hooks.map((hook) => [hook.sessionId, hook]));
  const hookByPane = new Map(
    hooks
      .filter((hook) => hook.paneKey)
      .map((hook) => [hook.paneKey!, hook]),
  );

  return fleet.workspaces
    .map((workspace) => {
      const label = workspaceLabel(workspace);
      const panes = workspace.tabs
        .flatMap((tab) => tab.panes)
        .filter((pane) => Boolean(pane.agent))
        .map((pane): HerdrPaneView => {
          const binding = bindingByPane.get(pane.pane_id) ?? null;
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
            status: liveStatus(hook, pane.agent_status),
            alive: fleet.available && (binding?.alive ?? true),
            pane,
            binding,
            hook,
          };
        })
        .sort(
          (a, b) =>
            urgency(a.status) - urgency(b.status) ||
            a.label.localeCompare(b.label),
        );
      return { id: workspace.workspace_id, label, panes };
    })
    .filter((workspace) => workspace.panes.length > 0)
    .sort(
      (a, b) =>
        Math.min(...a.panes.map((pane) => urgency(pane.status))) -
          Math.min(...b.panes.map((pane) => urgency(pane.status))) ||
        a.label.localeCompare(b.label),
    );
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
