export const HERDR_PROTOCOL = 19;

export type HerdrAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

export type HerdrAgentSession = {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
};

export type HerdrPane = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: HerdrAgentStatus;
  revision: number;
  agent?: string | null;
  agent_session?: HerdrAgentSession | null;
  label?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  [key: string]: unknown;
};

export type HerdrAgent = {
  name?: string | null;
  pane_id: string;
  state_change_seq?: number;
  [key: string]: unknown;
};

export type HerdrWorkspace = {
  workspace_id: string;
  worktree?: import("../herdr-ui").HerdrWorktree | null;
  [key: string]: unknown;
};

export type HerdrTab = {
  tab_id: string;
  workspace_id: string;
  [key: string]: unknown;
};

export type HerdrLayout = {
  tab_id: string;
  workspace_id: string;
  [key: string]: unknown;
};

export type HerdrSnapshot = {
  version: string;
  protocol: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  layouts: HerdrLayout[];
  agents: HerdrAgent[];
};

export type HerdrSnapshotResult = {
  type: "session_snapshot";
  snapshot: HerdrSnapshot;
};

export type HerdrResponse<T = Record<string, unknown>> =
  | { id: string; result: T }
  | { id: string; error: { code: string; message: string } };

export type HerdrEvent = {
  event: string;
  data: Record<string, unknown>;
};

export type HerdrClientState = {
  enabled: boolean;
  available: boolean;
  realtime: boolean;
  readOnly: boolean;
  protocol: number | null;
  version: string | null;
  socketPath: string;
  generation: number;
  lastError: string | null;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  layouts: HerdrLayout[];
  agents: HerdrAgent[];
};

export type HerdrClientChange =
  | { kind: "snapshot" }
  | { kind: "pane"; pane: HerdrPane }
  | { kind: "pane-closed"; paneId: string }
  | { kind: "fleet" };
