import { create } from "zustand";
import type { Mode, ProviderId, ProviderInfo } from "@/lib/llm";
import { DEFAULT_PROVIDER, isProviderId, PROVIDERS } from "@/lib/llm";
import type {
  Bookmark,
  ChatNode,
  NodeAttachment,
  Note,
  ParentAnchor,
  Session,
  ToolCall,
} from "@/lib/types";
import {
  BOOKMARK_QUESTION_LIMIT,
  BOOKMARK_RESPONSE_LIMIT,
  bookmarkSummary,
  mergeBookmarkWindowIntoNodes,
} from "@/lib/bookmarks";
import {
  clearStreamPending,
  emitStream,
  getStreamPending,
  thinkingChannel,
} from "@/lib/stream-bus";
import { ancestorsOf, subtreeIds } from "@/lib/collapsed";
import { type SendKey, SEND_KEY_DEFAULT, isSendKey } from "@/lib/send-key";
import {
  type ThreadWidth,
  THREAD_WIDTH_DEFAULT,
  isThreadWidth,
} from "@/lib/thread-width";
import { type TreePanelView, isTreePanelView } from "@/lib/tree-panel";
import { uuid } from "@/lib/uuid";

// Phase A reference creation payloads. Mirrors the server's CreateRequest
// union; keep these in sync with app/api/references/route.ts.
export type CreateReferenceInput =
  | { sourceType: "paste"; pastedText: string; title?: string }
  | { sourceType: "url"; url: string };

const PROVIDER_KEY = "trellis-provider";
// MODE_KEY semantics changed in Stage 14: was the runtime mode (globally
// applied to all sessions); now it's only a hint for *new* sessions —
// active sessions read their locked mode from the DB.
const MODE_KEY = "trellis-mode";
const WORKSPACE_KEY = "trellis-workspace";
// D1: draft custom system prompt for new chat sessions (locked into the
// session row on first POST, like draftMode/draftWorkspacePath).
const SYSTEM_PROMPT_KEY = "trellis-system-prompt";
// S88: 新会话选中的 Agent（agents.id）。与 SYSTEM_PROMPT_KEY 同纪律 —— 只是
// 「下一个新会话用谁」的草稿，已建会话从 DB 行读回自己锁定的那个。
const AGENT_KEY = "trellis-agent-id";
// A4: global send-key preference (applies to all chat inputs immediately).
const SEND_KEY_KEY = "trellis-send-key";
// D2: how many ancestor turns chat folds into the prompt. Default 4
// (was a hardcoded 2) — deeper context for branched conversations, at a token
// cost the user can dial back. project mode ignores this (history is in the
// resumed CLI session). 0 = B-fork (append-only, chat+claude default: history
// lives in the forked CLI session, cache-friendly, no forgetting); 1-12 =
// window-mode fallback (fold N ancestor turns into the prompt).
const HISTORY_DEPTH_KEY = "trellis-history-depth";
// One-shot flag: B-fork changed the default depth 4→0. See migrateHistoryDepth.
const HISTORY_DEPTH_MIGRATED_KEY = "trellis-history-depth-migrated";
const DEFAULT_HISTORY_DEPTH = 0;
// chat enhanced-mode toggle: when on, chat gets workspace+full (skills + web,
// YOLO). Global runtime preference, default off. Sent on every chat request.
const CHAT_ENHANCED_KEY = "trellis-chat-enhanced";
// 权限确认 draft（project 新会话的开关记忆）。
const REQUIRE_APPROVAL_KEY = "trellis-require-approval";
// 线性视图内容列宽度（窄/宽/超宽），全局偏好。
const THREAD_WIDTH_KEY = "trellis-thread-width";
const TREE_PANEL_VIEW_KEY = "trellis-tree-panel-view";
const COLLAPSED_KEY = (sid: string) => `trellis-collapsed:${sid}`;
// Workbench Wave 4 (VSCode-style IDE shell):
// - pinned tabs (ordered) persist across reloads, like VSCode's permanently
//   opened editor tabs.
// - the left explorer sidebar open/closed state persists (desktop default on).
const PINNED_KEY = "trellis-pinned-sessions";
const SIDEBAR_KEY = "trellis-sidebar-open";

function loadPinned(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function persistPinned(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.length === 0) window.localStorage.removeItem(PINNED_KEY);
    else window.localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function loadSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(SIDEBAR_KEY);
  // Desktop default = open; only an explicit "0" closes it.
  return raw === null ? true : raw !== "0";
}

// Per-session collapsed-set persistence — sessionStorage so it survives
// reload but doesn't leak across tabs or re-appear weeks later. Key is
// scoped by sessionId; we never persist collapse state for a session
// that hasn't been loaded yet.
function loadCollapsed(sessionId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(COLLAPSED_KEY(sessionId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function persistCollapsed(
  sessionId: string | undefined,
  ids: Set<string>,
): void {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    if (ids.size === 0) {
      window.sessionStorage.removeItem(COLLAPSED_KEY(sessionId));
    } else {
      window.sessionStorage.setItem(
        COLLAPSED_KEY(sessionId),
        JSON.stringify([...ids]),
      );
    }
  } catch {
    /* quota / private mode — non-fatal */
  }
}

// 树面板真热度：per-session { rootId: lastVisitedAt }。导航落到某棵树
// （setActiveNode / jump*）就给树根打点——重访旧树不长新节点也算「用过」，
// 补上 createdAt/readAt 代理信号覆盖不到的那一面。localStorage 持久化
// （lastViewed 同款），load 时按现存根修剪防垃圾堆积。
const TREE_VISITS_KEY = (sid: string) => `trellis-tree-visits:${sid}`;

function loadTreeVisits(sessionId: string): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(TREE_VISITS_KEY(sessionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persistTreeVisits(
  sessionId: string | undefined,
  visits: Record<string, number>,
): void {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    if (Object.keys(visits).length === 0) {
      window.localStorage.removeItem(TREE_VISITS_KEY(sessionId));
    } else {
      window.localStorage.setItem(
        TREE_VISITS_KEY(sessionId),
        JSON.stringify(visits),
      );
    }
  } catch {
    /* quota / private mode — non-fatal */
  }
}

// Per-session "last viewed position": which node the user was looking at and
// whether they were in the fullscreen reader vs the canvas. Persisted to
// localStorage (survives reload / app restart, unlike collapsed which is
// per-tab sessionStorage) so reopening a session lands back where you left.
const VIEW_KEY = (sid: string) => `trellis-view:${sid}`;

export type ViewMode = "canvas" | "linear";

type ViewState = {
  activeNodeId: string | null;
  viewMode?: ViewMode;
  // Legacy (pre linear-unification): the fullscreen card reader flag. Read
  // once for migration (true → viewMode "linear"), never written anymore.
  fullScreen?: boolean;
  // Linear-thread reading position: the card whose top straddles the scroll
  // viewport's top edge + how many px of it are scrolled past. activeNodeId
  // alone can't express this — it's the lineage anchor and doesn't move while
  // the user scrolls/reads, so restoring only it always landed tab switches
  // back on the root card.
  lastViewed?: ReadingPosition;
};

export type ReadingPosition = { nodeId: string; offset: number };

function parseReadingPosition(value: unknown): ReadingPosition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { nodeId?: unknown; offset?: unknown };
  if (typeof v.nodeId !== "string" || typeof v.offset !== "number") {
    return undefined;
  }
  return { nodeId: v.nodeId, offset: Math.max(0, Math.round(v.offset)) };
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "canvas" || value === "linear";
}

function defaultViewModeForSession(session: Pick<Session, "mode"> | null): ViewMode {
  return session?.mode === "project" ? "linear" : "canvas";
}

function loadViewState(sessionId: string): ViewState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VIEW_KEY(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      activeNodeId:
        typeof parsed.activeNodeId === "string" ? parsed.activeNodeId : null,
      viewMode: isViewMode(parsed.viewMode) ? parsed.viewMode : undefined,
      fullScreen: Boolean(parsed.fullScreen),
      lastViewed: parseReadingPosition(parsed.lastViewed),
    };
  } catch {
    return null;
  }
}

function persistViewState(
  sessionId: string | undefined,
  state: ViewState,
): void {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    window.localStorage.setItem(VIEW_KEY(sessionId), JSON.stringify(state));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function loadProvider(): ProviderId {
  if (typeof window === "undefined") return DEFAULT_PROVIDER;
  const stored = window.localStorage.getItem(PROVIDER_KEY);
  return isProviderId(stored) ? stored : DEFAULT_PROVIDER;
}

function isMode(s: unknown): s is Mode {
  return s === "chat" || s === "project";
}

function loadDraftMode(): Mode {
  if (typeof window === "undefined") return "chat";
  const stored = window.localStorage.getItem(MODE_KEY);
  // Migrate previous values: boolean cli-mode flag, Stage-13 names, then the
  // retired workspace tier (2026-07-16) — tool-flavored drafts fold into
  // project, everything else falls back to chat.
  if (stored === null) {
    const legacy = window.localStorage.getItem("trellis-cli-mode");
    if (legacy === "1") return "project";
    return "chat";
  }
  if (stored === "lean") return "chat";
  if (stored === "cli-single" || stored === "workspace") return "project";
  if (stored === "cli-multi") return "project";
  return isMode(stored) ? stored : "chat";
}

function loadDraftWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(WORKSPACE_KEY);
  return stored && stored.trim() ? stored : null;
}

function loadDraftSystemPrompt(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(SYSTEM_PROMPT_KEY);
  return stored && stored.trim() ? stored : null;
}

function loadDraftAgentId(): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(AGENT_KEY);
  return stored && stored.trim() ? stored : null;
}

function loadSendKey(): SendKey {
  if (typeof window === "undefined") return SEND_KEY_DEFAULT;
  const stored = window.localStorage.getItem(SEND_KEY_KEY);
  return isSendKey(stored) ? stored : SEND_KEY_DEFAULT;
}

function clampDepth(n: number): number {
  return Number.isFinite(n) && n >= 0 && n <= 12 ? Math.round(n) : DEFAULT_HISTORY_DEPTH;
}
// One-time migration to the B-fork era. Before B-fork the default depth was 4
// and the knob only ever stored 2/4/6/8 (window mode). Those persisted values
// would silently pin upgraded users to window mode and deny them B-fork
// (append-only + cache). Clear the stored value ONCE so everyone lands on the
// new default (0 = B-fork); the flag makes it idempotent, and a user who still
// wants window mode just re-picks a depth (which re-persists). Runs before
// loadHistoryDepth reads the key.
function migrateHistoryDepth(): void {
  if (typeof window === "undefined") return;
  if (window.localStorage.getItem(HISTORY_DEPTH_MIGRATED_KEY)) return;
  window.localStorage.removeItem(HISTORY_DEPTH_KEY);
  window.localStorage.setItem(HISTORY_DEPTH_MIGRATED_KEY, "1");
}
function loadHistoryDepth(): number {
  if (typeof window === "undefined") return DEFAULT_HISTORY_DEPTH;
  migrateHistoryDepth();
  const raw = window.localStorage.getItem(HISTORY_DEPTH_KEY);
  return raw ? clampDepth(parseInt(raw, 10)) : DEFAULT_HISTORY_DEPTH;
}

function loadChatEnhanced(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(CHAT_ENHANCED_KEY) === "1";
}

function loadDraftRequireApproval(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(REQUIRE_APPROVAL_KEY) === "1";
}

function loadThreadWidth(): ThreadWidth {
  if (typeof window === "undefined") return THREAD_WIDTH_DEFAULT;
  const stored = window.localStorage.getItem(THREAD_WIDTH_KEY);
  return isThreadWidth(stored) ? stored : THREAD_WIDTH_DEFAULT;
}

function loadTreePanelView(): TreePanelView {
  if (typeof window === "undefined") return "list";
  const stored = window.localStorage.getItem(TREE_PANEL_VIEW_KEY);
  return isTreePanelView(stored) ? stored : "list";
}

// API node → client node (add position field, drop nullable distinction)
// toolCalls 可选：GET /api/sessions/[id] 已剥离完整数组（改发 toolCallStats +
// generatedFiles），按需走 GET /api/nodes/[id]/tool-calls；单节点端点仍带全量。
type ApiNode = Omit<ChatNode, "position" | "topicLabel" | "toolCalls"> & {
  topicLabel?: string | null;
  toolCalls?: ToolCall[];
};

function apiNodeToChatNode(n: ApiNode): ChatNode {
  return {
    ...n,
    toolCalls: n.toolCalls ?? [],
    position: { x: 0, y: 0 },
    topicLabel: n.topicLabel ?? null,
  };
}

type State = {
  session: Session | null;
  nodes: Record<string, ChatNode>;
  activeNodeId: string | null;
  hydrated: boolean;
  hydrateError: string | null;
  provider: ProviderId;
  // Live model catalog from GET /api/providers (sourced from
  // endpoints.yaml, optional). Seeded with the static PROVIDERS
  // fallback until the fetch (fired once from hydrate()) resolves.
  providerCatalog: ProviderInfo[];
  // Stage 14: mode is per-session and locked at creation. The runtime
  // mode for the currently-loaded session is derived from `session.mode`
  // (see ModeBadge). The store keeps two independent "draft" fields that
  // only matter when starting a brand-new session — the QuestionInput
  // mode bar reads + writes these, then the server locks them into the
  // sessions row on first POST.
  draftMode: Mode;
  draftWorkspacePath: string | null;
  // D1: draft system prompt for the next new chat session. null = use the
  // built-in default. Only consumed when creating a brand-new session.
  draftSystemPrompt: string | null;
  // S88: 下一个新会话的人设（agents.id）。null = 默认 Agent。
  draftAgentId: string | null;
  setDraftAgentId: (id: string | null) => void;
  // A4: send-key preference, applied live to every chat input.
  sendKey: SendKey;
  // 线性视图内容列宽度偏好（窄/宽/超宽）。
  threadWidth: ThreadWidth;
  // 树面板当前树节点区的展示形态（列表/图形）。
  treePanelView: TreePanelView;
  // D2: ancestor turns folded into chat prompts (1–12).
  historyDepth: number;
  // chat enhanced-mode (skills + web, YOLO). Global, default off.
  chatEnhanced: boolean;
  // 权限确认 draft：新建 project 会话时是否开审批（创建后锁进
  // session 行，运行态读 session.requireApproval）。仅 claude 系生效。
  draftRequireApproval: boolean;
  // Bumps every time the server's session list might have changed —
  // SessionPicker watches this to refetch.
  sessionsRevision: number;
  // Force every session-list consumer (sidebar / tabs) to refetch. Used by
  // the CLI attach picker after attach/detach changes the session set.
  bumpSessionsRevision: () => void;
  // CLI 同步「live 感知」：正被一个活的 claude 进程实时写的 attached 会话集合。
  // 信号 = SSE session_updated 事件（持续写 = 持续 live），收到就 markSessionLive
  // 续期 LIVE_TTL_MS；停写后自动褪去。给侧栏一个 remote-control 式的「● live」脉冲。
  liveSessionIds: Set<string>;
  markSessionLive: (sessionId: string) => void;
  // #7: the two surfaces. "linear" = the unified reading/chat thread (all
  // modes; replaced the old NodeFullView fullscreen reader), "canvas" = the
  // tree structure view. Project sessions default to linear; chat defaults
  // to canvas on desktop, linear on mobile (page effect).
  viewMode: ViewMode;
  // #5: stream failures that happen before the server creates a node (fetch
  // refused / non-2xx). There's no node to attach the error to, so it
  // surfaces through this global slot → StreamAlertToast. Auto-cleared.
  streamAlert: string | null;
  // Latest progress message per streaming reference node. Set as the
  // claude fetcher emits SSE `progress` events; cleared when the node
  // transitions to status=done. Transient — never persisted.
  fetchProgress: Record<string, string>;
  // 按需拉取 toolCalls 的在途标记（nodeId → loading）。GET /api/sessions/[id]
  // 不再下发完整数组，展开动线时由 loadNodeToolCalls 拉取；这个 map 让 UI
  // 能显示「加载中…」并给 action 去重（同节点不并发拉两次）。
  toolCallsLoading: Record<string, boolean>;
  // When user wants to land inside a node *and* highlight a specific
  // span: clicking "↳ 从「xxx」分叉" on a child (kind="child", anchored
  // by data-child-id), or jumping back from a note in NotesDrawer
  // (kind="note", anchored by data-note-id). Consumed + cleared by
  // NodeFullView's ResponseBody scroll effect.
  pendingScrollAnchor:
    | { nodeId: string; kind: "child"; childId: string }
    | { nodeId: string; kind: "note"; noteId: string }
    | {
        nodeId: string;
        kind: "search";
        // Surface the FTS snippet (markers stripped) so the anchor
        // injector can wrap it in <mark data-search-id>. matchKind
        // narrows which DOM region — question vs response/reference —
        // the consumer should target.
        matchText: string;
        matchKind: "question" | "response" | "reference";
      }
    | null;
  // Toasts emitted when a node finishes streaming AND the user is not
  // currently focused on it (activeNodeId !== that node). Lets the user
  // know "#7 完成" is ready to read without context-switching mid-flow.
  // DoneToast component renders these in the bottom-right and auto-clears
  // each entry after the toast component's timer fires.
  // kind "waiting" = run 暂停在交互式工具（AskUserQuestion / 权限确认）等
  // 用户回答——不自动消失，回答 / 终结后由 store 清除。
  doneToasts: Array<{
    nodeId: string;
    emittedAt: number;
    kind?: "done" | "waiting";
  }>;
  // Anti-misfire for Esc-to-abort: a single Esc only *arms* a confirm prompt
  // (abortArm); a second Esc within the window actually stops the run. A
  // stray single press can no longer kill a long-running task.
  abortArm: { nodeId: string; label: string } | null;
  // After a user-initiated stop, a recovery toast offers one-click re-run so
  // an accidental abort is instantly recoverable.
  abortRecovery: { nodeId: string; label: string } | null;
  // Notebook entries for the currently loaded session. Hydrated alongside
  // nodes from /api/sessions/[id], mutated optimistically by addNote /
  // deleteNote. Empty when no session loaded.
  notes: Note[];
  // Cross-session card bookmarks. Unlike notes, this list is global and is
  // not cleared when the active session changes.
  bookmarks: Bookmark[];
  // Server-side count is separate from the bounded bookmark row window.
  bookmarksTotal: number;
  bookmarksOpen: boolean;
  // Whether the right-side NotesDrawer is open. UI-only — not persisted.
  notesOpen: boolean;
  // Stage 16: cross-session search modal visibility. Lifted into store so
  // both the ⌘P global keydown listener and the Header 🔍 button (mobile
  // entry point) can toggle the same modal.
  searchOpen: boolean;
  // Global file-preview overlay target. Lifted into the store so every entry
  // point (generated-files chips, clickable inline paths in answers, a future
  // workspace browser) opens the same one. relPath is workspace-relative; the
  // preview reads the live file from /api/files for the active session. null =
  // closed.
  filePreview: { path: string; name: string } | null;
  // Whether the workspace-files drawer (read-only browser of the session's
  // cwd, entered via the Header ModeBadge) is open. UI-only — not persisted.
  workspaceFilesOpen: boolean;
  // B1: mobile outline drawer visibility. Desktop shows the outline as a
  // permanent left rail (md:block); mobile (which defaults to fullscreen,
  // hiding the rail) opens it as a full-height drawer via a Header button.
  outlineOpen: boolean;
  // M2: full-screen TreePanel sheet on phones. Closed by default so the
  // navigator is not mounted over the linear reading/composer surface.
  mobileTreePanelOpen: boolean;
  // B3: visibility of the "新话题（清空上下文）" composer (NewQuestionPicker).
  // Lifted into the store so both the canvas FAB and the Header context-
  // pressure prompt (the /compact degradation entry) can open the same modal.
  composeRootOpen: boolean;
  // Set of nodeIds whose subtree is currently folded — collapsed nodes
  // themselves stay visible, but every descendant is hidden from the
  // canvas (and the outline). Persisted to sessionStorage per-session
  // so reload preserves the user's current focus posture without
  // bleeding into the data model.
  collapsedNodeIds: Set<string>;
  // Most recently created / streamed / retried / refreshed node in the
  // current session. Used to pan the canvas onto it whenever the user
  // returns from NodeFullView, so they land on the freshest work
  // instead of whatever the previous viewport was. In-memory only;
  // on session load we seed from the highest createdAt as a proxy.
  lastEditedNodeId: string | null;
  // Linear-thread reading position for the CURRENT session (see ViewState.
  // lastViewed). Written by LinearThreadView's scroll tracker, persisted by
  // the view-state subscription, seeded back by loadSessionInternal so
  // switching tabs lands on the card the user was reading, not the root.
  readingPosition: ReadingPosition | null;
  // 树面板真热度：当前 session 的 { rootId: lastVisitedAt }。导航打点写入，
  // loadSessionInternal 载入 + 修剪。TreePanel 把它并进树热度。
  treeVisits: Record<string, number>;
  // 手动标未读的节点（内存，不持久化）：挡住线性视图「视口停留 1s 自动
  // 已读」——邮件语义，瞥见不算读。显式导航到该节点（setActiveNode）或
  // 手动标回已读时解除。
  unreadHolds: Record<string, true>;
  // ── Workbench Wave 4: VSCode-style IDE shell ────────────────────────
  // The single active session that is *previewed* (single-click in the
  // sidebar / opened transiently). Shown as an italic temporary tab and
  // replaced the moment another preview happens. null = no preview tab.
  // A previewed id never appears in pinnedSessionIds simultaneously.
  previewSessionId: string | null;
  // Pinned (permanently opened) tabs, in user-visible order. Persisted to
  // localStorage so the workbench survives reload. Double-click pins.
  pinnedSessionIds: string[];
  // Sessions that finished a run while the user was *not* looking at them
  // (computed by the run-poll diff). Cleared the moment loadSession lands
  // on that id. Drives the emerald "完成·未读" badge on tabs + sidebar rows.
  unreadSessionIds: Set<string>;
  // Sessions with ≥1 streaming node right now (the run-poll snapshot).
  // Shared from the central poll so SessionTabs + SessionSidebar don't each
  // run their own interval. Drives the blue running pulse.
  runningSessionIds: Set<string>;
  // Same poll, kept at node granularity for the Recent chain rows. Waiting is
  // exclusive from running here; the UI applies waiting > running priority.
  runningNodeIds: Set<string>;
  waitingNodeIds: Set<string>;
  // Left explorer sidebar open/closed (desktop). Persisted to localStorage.
  sidebarOpen: boolean;
  // Mobile session-list drawer (the sidebar is hidden on mobile; this overlays
  // it on demand). Ephemeral — not persisted, defaults closed so a session
  // isn't hidden behind it on load. Opened by the Header hamburger.
  mobileNavOpen: boolean;
};

type Actions = {
  hydrate: (sessionId?: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  newConversation: () => void;
  // ── Workbench Wave 4: VSCode tab management ─────────────────────────
  // Single-click a sidebar item: load it + mark it as the (transient)
  // preview tab unless it's already pinned. Replaces any prior preview.
  previewSession: (sessionId: string) => Promise<void>;
  // Double-click / "keep open": move into pinned (deduped, appended) +
  // clear preview if it was previewing this id + load it.
  pinSession: (sessionId: string) => Promise<void>;
  // Close a tab (the × on a tab). If pinned → remove from pinned. If it was
  // the preview → clear preview. If we closed the active session, switch to
  // an adjacent still-open tab, else drop to the new-conversation screen.
  closeTab: (sessionId: string) => void;
  // Central run-poll diff: feed the latest set of running session ids; the
  // store computes the "finished while away" unread diff against the prior
  // snapshot. Called by useRunPolling only.
  ingestRunningSessions: (
    ids: Set<string>,
    runningNodeIds: Set<string>,
    waitingNodeIds: Set<string>,
  ) => void;
  setSidebarOpen: (open: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;
  setNodePosition: (nodeId: string, pos: { x: number; y: number }) => void;
  setActiveNode: (nodeId: string | null) => void;
  // Record the linear thread's reading position. sessionId guards the
  // debounced scroll tracker against landing a stale write after a tab
  // switch (the old session's position must never be filed under the new
  // session's key).
  setReadingPosition: (sessionId: string, pos: ReadingPosition) => void;
  setProvider: (provider: ProviderId) => void;
  fetchProviderCatalog: () => Promise<void>;
  // Stage 14: only affects subsequent new-session creation. No-op for
  // currently active session.
  setDraftMode: (mode: Mode) => void;
  setDraftWorkspacePath: (path: string | null) => void;
  setDraftSystemPrompt: (prompt: string | null) => void;
  setSendKey: (key: SendKey) => void;
  setThreadWidth: (width: ThreadWidth) => void;
  setTreePanelView: (view: TreePanelView) => void;
  setViewMode: (mode: ViewMode) => void;
  setStreamAlert: (message: string | null) => void;
  // Stream a new root question.
  // - default (no opts): creates a brand-new session + root node.
  // - attachToCurrentSession=true: adds a parallel root to the current session
  //   (parent_id=NULL, fresh lineage but shares Session container).
  streamRoot: (
    question: string,
    opts?: {
      attachToCurrentSession?: boolean;
      attachments?: NodeAttachment[];
    },
  ) => Promise<void>;
  // Stream a new branch from an existing parent.
  streamBranch: (
    parentId: string,
    question: string,
    anchor: ParentAnchor | null,
    opts?: { attachments?: NodeAttachment[]; mentionAgentSlug?: string | null },
  ) => Promise<void>;
  // Re-run an existing node in place: server keeps the same id, wipes the
  // response/usage/error, and re-streams against the original question +
  // parent context. Avoids polluting the tree with retry siblings.
  retryNode: (nodeId: string) => Promise<void>;
  // 按需拉取单个节点的完整 toolCalls（GET /api/nodes/[id]/tool-calls）。
  // 会话载荷已剥离这部分，展开动线面板时调用。幂等：已有数据 / 在途中直接返回。
  loadNodeToolCalls: (nodeId: string) => Promise<void>;
  // Cancel an in-flight stream. Triggers fetch abort → server marks the row
  // status="error" / errorMessage="aborted" with whatever partial response
  // was already persisted. No-op if the node has no controller registered
  // (already done, or never streamed).
  abortStream: (nodeId: string) => void;
  // True if any node currently has a registered stream controller. Used by
  // the global Esc handler to find a target without subscribing to nodes.
  hasStreamingNode: () => boolean;
  // Stage 17: open GET /api/nodes/[id]/stream for every node in the
  // current session that's still in streaming state but has no live SSE
  // attached. Triggered by visibilitychange (mobile tab waking), online
  // (network restored), and at the tail of loadSession. Idempotent —
  // running it 3x in a row is the same as running it once.
  reconnectStreamingNodes: () => void;
  // Most recently registered streaming nodeId (for Esc to find a target
  // when activeNodeId isn't itself streaming).
  latestStreamingNodeId: () => string | null;
  // Create a reference (paste / URL) attached to the current session.
  // Returns the new node; callers can use its id to focus it. Throws if
  // there's no active session (FAB UI gates this).
  createReference: (input: CreateReferenceInput) => Promise<ChatNode>;
  // Re-fetch a URL-backed reference. No-op for paste / file types.
  refreshReference: (nodeId: string) => Promise<void>;
  // Mark a node as read. Idempotent. Optimistically patches the store
  // before the server round-trip finishes — UI feedback is instant; if
  // the POST fails (network glitch, etc.) we silently revert.
  markNodeRead: (nodeId: string) => Promise<void>;
  // 手动标回未读（卡片头 / 树面板行的 toggle）。乐观清 readAt + 设
  // unreadHolds 抑制视口自动回读，失败回滚。仅对已读的 done 节点生效。
  markNodeUnread: (nodeId: string) => Promise<void>;
  refreshBookmarks: () => Promise<void>;
  toggleBookmark: (nodeId: string, on?: boolean) => Promise<void>;
  setBookmarksOpen: (open: boolean) => void;
  // 树面板雪藏：隐藏 / 恢复 nodeId 所在的整棵树（标记落在树根）。乐观更新，
  // 失败回滚。幂等。
  setTreeHidden: (nodeId: string, hidden: boolean) => Promise<void>;
  // 树命名 / 重命名：修改 nodeId 所在树根的 topicLabel。乐观更新，失败回滚。
  renameTree: (nodeId: string, title: string) => Promise<void>;
  // A路③: answer a paused interactive tool (AskUserQuestion / ExitPlanMode).
  // Optimistically clears node.pendingInteraction (the interaction_resolved
  // SSE event also clears it — idempotent). On 404/409 (stale: run no longer
  // live, or a different toolUseId is pending) it still clears the form and
  // returns { ok:false, reason:"stale" } so the UI can flash "会话已失效".
  // Other failures (network / 400 / 5xx) return { ok:false, reason:"error" }
  // WITHOUT clearing, so the user can retry. Restores pendingInteraction if
  // it was optimistically cleared but the request failed retryably.
  respondToInteraction: (
    nodeId: string,
    toolUseId: string,
    decision: {
      behavior: "allow" | "deny";
      updatedInput?: unknown;
      message?: string;
      // 权限确认：allow 时同名工具本轮内不再弹卡。
      alwaysAllowTool?: boolean;
    },
  ) => Promise<{ ok: true } | { ok: false; reason: "stale" | "error" }>;
  // Combined "go to parent + scroll its response to the mark for this
  // child" action. Sets pendingScrollAnchor first so the consumer effect
  // sees it on the next render, then flips activeNodeId.
  jumpToParentAtAnchor: (parentId: string, childId: string) => void;
  // "Open notebook entry": navigates to the note's source node and asks
  // its ResponseBody to scroll the mark[data-note-id] into view + pulse.
  // No-op (silent) if the note id isn't in the store (rare race).
  jumpToNoteSource: (noteId: string) => void;
  // Stage 16: navigate to a search result. Loads the target session if
  // needed, focuses the node, switches to fullscreen, and (for q/r/ref
  // hits) sets a pendingScrollAnchor for the inline pulse. Note hits
  // delegate to jumpToNoteSource — call that directly from the UI.
  jumpToSearchHit: (args: {
    sessionId: string;
    nodeId: string;
    matchText: string;
    matchKind: "question" | "response" | "reference";
  }) => Promise<void>;
  // S133：侧栏「最近」分组的跨会话落点 —— 切到 sessionId（走 previewSession，
  // tab / 未读角标 / SSE 重连全部同款）后把 nodeId 设为锚点：线性视图沿它重算
  // 链并滚过去，画布平移到它。已在该会话时只换锚点不重载（重载会把节点位置
  // 归零，见 previewSession 的注释）。
  openNodeInSession: (sessionId: string, nodeId: string) => Promise<void>;
  clearScrollAnchor: () => void;
  // Remove a single done toast (timer expiry or user dismiss/click).
  dismissDoneToast: (nodeId: string) => void;
  setAbortArm: (v: { nodeId: string; label: string } | null) => void;
  setAbortRecovery: (v: { nodeId: string; label: string } | null) => void;
  // Capture a quoted excerpt as a note. Optimistic: prepends a temp
  // entry, swaps in the server's id once POST resolves; rolls back on
  // failure. Returns the persisted note (or throws).
  addNote: (sourceNodeId: string, quotedText: string) => Promise<Note>;
  deleteNote: (noteId: string) => Promise<void>;
  setNotesOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  openFilePreview: (absPath: string) => void;
  closeFilePreview: () => void;
  setWorkspaceFilesOpen: (open: boolean) => void;
  setOutlineOpen: (open: boolean) => void;
  setMobileTreePanelOpen: (open: boolean) => void;
  setComposeRootOpen: (open: boolean) => void;
  setHistoryDepth: (n: number) => void;
  setChatEnhanced: (v: boolean) => void;
  setDraftRequireApproval: (v: boolean) => void;
  // A2: re-ask an existing node's question with an edited wording. Creates a
  // new sibling (same parent + anchor) — original Q&A is preserved (Q1 = B).
  editNode: (nodeId: string, newQuestion: string) => Promise<void>;
  // Toggle collapse on a node. No-op semantically meaningful even on
  // leaves (allows "pre-collapse" before children exist) but UIs should
  // hide the toggle when there are no descendants.
  // Cascade-delete a node + every descendant (qa or reference) + every
  // note attached to anything in the subtree. Optimistic: removes from
  // local store immediately, posts to /api/nodes/:id, reverts on
  // failure. Refuses (no-op) if the target is the session's qa root —
  // the caller should redirect the user to delete-session in that case.
  // Returns null on no-op, otherwise the count of what was removed.
  deleteNode: (
    nodeId: string,
  ) => Promise<
    | { deletedNodeIds: string[]; deletedNoteIds: string[] }
    | null
  >;
  toggleCollapse: (nodeId: string) => void;
  // Force-expand the entire ancestor chain of `nodeId` so the node is
  // reachable on the canvas. Called whenever something navigates to a
  // node (setActiveNode, jumpToParentAtAnchor, jumpToNoteSource) and
  // when a new child is created underneath a collapsed parent.
  expandAncestors: (nodeId: string) => void;
};

// Module-level so identity survives store updates and is never serialized
// into Zustand state (AbortController is not safe to clone). nodeId only
// becomes known once the server emits `created`, so we register inside
// handleStreamEvent's created branch.
const STREAM_CONTROLLERS = new Map<string, AbortController>();
// CLI 同步 live 感知：每个 session 的「褪去」定时器 + live 续期窗口。模块级（不进
// React state），markSessionLive 收到新事件就清旧定时器、重置 TTL。
const LIVE_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();
// 60s 而非 12s：信号源是「jsonl 又被写了」，而 CLI 跑一条长 Bash / 长 Task 期间
// 根本不写盘。实测真实 transcript 的相邻条目间隔，13.78% 超过 12s（1408 次超过
// 60s，最长 3576s）—— 12s 的窗口会让一个明明在跑的会话反复「诈死」，侧栏 live
// 灯闪烁，且 EmptyResponseNotice 会据此断言这轮没有输出。
const LIVE_TTL_MS = 60_000;
// Insertion-ordered list — last entry is the most recently started stream.
// Map.keys() preserves insertion order so we don't need a separate array.

// streamRoot/streamBranch register their controller inside handleStreamEvent's
// `created` branch (nodeId isn't known until the server emits it), and the
// terminal branches there clean up via cleanupController(). When the SSE
// reader exits without ever delivering a terminal event — network drop,
// Safari freezing a backgrounded fetch — the entry would otherwise leak.
// reconnectStreamingNodes skips nodes that still have a controller registered
// (to avoid double-subscribing the run-bus), so a stale entry blocks reconnect
// forever. Call this in finally to drop whichever entry our controller owns.
function releaseStreamController(controller: AbortController): void {
  for (const [id, ctrl] of STREAM_CONTROLLERS) {
    if (ctrl === controller) {
      STREAM_CONTROLLERS.delete(id);
      return;
    }
  }
}

export const useSessionStore = create<State & Actions>((set, get) => ({
  session: null,
  nodes: {},
  activeNodeId: null,
  hydrated: false,
  hydrateError: null,
  provider: DEFAULT_PROVIDER,
  providerCatalog: PROVIDERS,
  draftMode: "chat",
  draftWorkspacePath: null,
  draftSystemPrompt: null,
  draftAgentId: null,
  sendKey: SEND_KEY_DEFAULT,
  threadWidth: THREAD_WIDTH_DEFAULT,
  treePanelView: "list",
  historyDepth: DEFAULT_HISTORY_DEPTH,
  chatEnhanced: false,
  draftRequireApproval: false,
  sessionsRevision: 0,
  bumpSessionsRevision: () =>
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 })),
  liveSessionIds: new Set<string>(),
  markSessionLive: (sessionId) => {
    const prev = LIVE_TIMERS.get(sessionId);
    if (prev) clearTimeout(prev);
    LIVE_TIMERS.set(
      sessionId,
      setTimeout(() => {
        LIVE_TIMERS.delete(sessionId);
        set((s) => {
          if (!s.liveSessionIds.has(sessionId)) return s;
          const next = new Set(s.liveSessionIds);
          next.delete(sessionId);
          return { liveSessionIds: next };
        });
      }, LIVE_TTL_MS),
    );
    set((s) => {
      if (s.liveSessionIds.has(sessionId)) return s;
      const next = new Set(s.liveSessionIds);
      next.add(sessionId);
      return { liveSessionIds: next };
    });
  },
  viewMode: "canvas",
  streamAlert: null,
  fetchProgress: {},
  toolCallsLoading: {},
  pendingScrollAnchor: null,
  doneToasts: [],
  abortArm: null,
  abortRecovery: null,
  notes: [],
  bookmarks: [],
  bookmarksTotal: 0,
  bookmarksOpen: false,
  notesOpen: false,
  searchOpen: false,
  filePreview: null,
  workspaceFilesOpen: false,
  outlineOpen: false,
  mobileTreePanelOpen: false,
  composeRootOpen: false,
  collapsedNodeIds: new Set(),
  lastEditedNodeId: null,
  readingPosition: null,
  treeVisits: {},
  unreadHolds: {},
  previewSessionId: null,
  pinnedSessionIds: loadPinned(),
  unreadSessionIds: new Set(),
  runningSessionIds: new Set(),
  runningNodeIds: new Set(),
  waitingNodeIds: new Set(),
  sidebarOpen: loadSidebarOpen(),
  mobileNavOpen: false,

  hydrate: async (sessionId) => {
    // S117: store 是模块级的，从 /settings 等路由返回主页会重新 mount 并再调
    // 一次 hydrate —— 不挡住的话它会把画面拽回 sessions[0]、把 preview tab
    // 覆盖成别的会话（与深链 loadSession 赛跑，谁后完成谁赢）。已经活着的
    // store 不需要二次自举。in-flight 标记防的是并发双跑（dev StrictMode
    // effect 双调时 hydrated 还没来得及变 true，实测第二个实例会在深链
    // previewSession 之后完成、把 preview tab 覆盖回 sessions[0]）。
    if (get().hydrated || hydrateInFlight) return;
    hydrateInFlight = true;
    set({
      provider: loadProvider(),
      draftMode: loadDraftMode(),
      draftWorkspacePath: loadDraftWorkspace(),
      draftSystemPrompt: loadDraftSystemPrompt(),
      draftAgentId: loadDraftAgentId(),
      sendKey: loadSendKey(),
      threadWidth: loadThreadWidth(),
      treePanelView: loadTreePanelView(),
      historyDepth: loadHistoryDepth(),
      chatEnhanced: loadChatEnhanced(),
      draftRequireApproval: loadDraftRequireApproval(),
    });
    void get().fetchProviderCatalog();
    void get().refreshBookmarks();
    try {
      let targetId = sessionId;
      if (!targetId) {
        const res = await fetchWithTimeout("/api/sessions", 5000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { sessions } = (await res.json()) as { sessions: Session[] };
        targetId = sessions[0]?.id;
      }
      if (!targetId) {
        set({ hydrated: true });
        return;
      }
      await loadSessionInternal(targetId, set);
      // Wave 4: surface the auto-loaded session as a tab. If the user had
      // it pinned across reloads, it's already an open tab; otherwise show
      // it as the (transient) preview tab so the strip isn't empty while a
      // session is active.
      // S117: 只在 preview 位还空着时落座 —— 深链的 previewSession 可能已经
      // 抢先占了位，hydrate 是兜底不是主张，不该把人挤下去。
      set((s) => ({
        hydrated: true,
        previewSessionId:
          s.previewSessionId ??
          (s.pinnedSessionIds.includes(targetId!) ? null : targetId!),
      }));
      // Stage 17: any rows still status='streaming' after hydrate must
      // be a stream that was alive when we last saw the page. Attach
      // reconnect SSE to each so live deltas / terminal events resume.
      get().reconnectStreamingNodes();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[trellis] hydrate failed:", err);
      set({ hydrated: true, hydrateError: message });
    } finally {
      hydrateInFlight = false;
    }
  },

  loadSession: async (sessionId) => {
    await loadSessionInternal(sessionId, set);
    // Wave 4: landing on a session clears its "finished while away" badge.
    set((s) => {
      if (!s.unreadSessionIds.has(sessionId)) return s;
      const next = new Set(s.unreadSessionIds);
      next.delete(sessionId);
      return { unreadSessionIds: next };
    });
    get().reconnectStreamingNodes();
  },

  newConversation: () => {
    set({
      session: null,
      nodes: {},
      activeNodeId: null,
      viewMode: "canvas",
      notes: [],
      collapsedNodeIds: new Set(),
      lastEditedNodeId: null,
      readingPosition: null,
      treeVisits: {},
      unreadHolds: {},
      mobileTreePanelOpen: false,
      // Wave 4: dropping to the composer screen is a "no tab is active"
      // state — leave the preview tab cleared so the bar doesn't keep an
      // orphan italic tab pointing at nothing.
      previewSessionId: null,
    });
  },

  // ── Workbench Wave 4: VSCode tab management ───────────────────────────
  previewSession: async (sessionId) => {
    const { pinnedSessionIds } = get();
    // Pinned sessions stay pinned (clicking a pinned tab is a plain switch,
    // not a preview). Only non-pinned ids occupy the single preview slot.
    set({
      previewSessionId: pinnedSessionIds.includes(sessionId)
        ? get().previewSessionId
        : sessionId,
    });
    // Already the active session → only update tab state, never reload.
    // Reloading resets every node position to (0,0) while the layoutKey
    // (id:parent:status) stays identical, so Canvas's dagre effect won't
    // re-fire and the nodes pile up at the origin.
    if (get().session?.id !== sessionId) await get().loadSession(sessionId);
  },

  pinSession: async (sessionId) => {
    set((s) => {
      const pinned = s.pinnedSessionIds.includes(sessionId)
        ? s.pinnedSessionIds
        : [...s.pinnedSessionIds, sessionId];
      if (pinned !== s.pinnedSessionIds) persistPinned(pinned);
      return {
        pinnedSessionIds: pinned,
        // Pinning consumes the preview slot if it was previewing this id.
        previewSessionId:
          s.previewSessionId === sessionId ? null : s.previewSessionId,
      };
    });
    // Pinning the already-active (previewed) session must NOT reload — that
    // would reset node positions to (0,0) without changing layoutKey, leaving
    // every node stacked at the origin. Only switch when it's a different one.
    if (get().session?.id !== sessionId) await get().loadSession(sessionId);
  },

  closeTab: (sessionId) => {
    const state = get();
    const wasActive = state.session?.id === sessionId;
    // Compute the ordered list of currently-open tabs (pinned, then preview)
    // *before* removal, so we can pick a neighbor if we closed the active one.
    const openOrder = [
      ...state.pinnedSessionIds,
      ...(state.previewSessionId &&
      !state.pinnedSessionIds.includes(state.previewSessionId)
        ? [state.previewSessionId]
        : []),
    ];
    const closingIdx = openOrder.indexOf(sessionId);

    const nextPinned = state.pinnedSessionIds.filter((id) => id !== sessionId);
    if (nextPinned.length !== state.pinnedSessionIds.length) {
      persistPinned(nextPinned);
    }
    const nextPreview =
      state.previewSessionId === sessionId ? null : state.previewSessionId;
    set({ pinnedSessionIds: nextPinned, previewSessionId: nextPreview });

    if (!wasActive) return;
    // Closed the active tab → switch to an adjacent still-open tab.
    const remaining = [
      ...nextPinned,
      ...(nextPreview && !nextPinned.includes(nextPreview)
        ? [nextPreview]
        : []),
    ];
    if (remaining.length === 0) {
      get().newConversation();
      return;
    }
    // Prefer the tab that took the closed one's slot (or the new last tab).
    const neighbor =
      remaining[Math.min(closingIdx, remaining.length - 1)] ?? remaining[0];
    void get().loadSession(neighbor);
  },

  ingestRunningSessions: (ids, runningNodeIds, waitingNodeIds) => {
    set((s) => {
      const prev = s.runningSessionIds;
      // Diff: any id that *was* running last tick but isn't now, and isn't
      // the session the user is currently looking at, just finished while
      // they were away → flag it unread.
      const activeId = s.session?.id ?? null;
      let unread = s.unreadSessionIds;
      let unreadChanged = false;
      for (const id of prev) {
        if (!ids.has(id) && id !== activeId) {
          if (!unread.has(id)) {
            if (!unreadChanged) {
              unread = new Set(unread);
              unreadChanged = true;
            }
            unread.add(id);
          }
        }
      }
      return {
        runningSessionIds: ids,
        runningNodeIds,
        waitingNodeIds,
        ...(unreadChanged ? { unreadSessionIds: unread } : {}),
      };
    });
  },

  setSidebarOpen: (open) => {
    set({ sidebarOpen: open });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
    }
  },

  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),

  deleteSession: async (sessionId) => {
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(COLLAPSED_KEY(sessionId));
    }
    // Wave 4: a deleted session must not linger as a tab. If it was the
    // active one, closeTab also handles switching to a neighbor; otherwise
    // just evict it from pinned/preview/unread.
    if (get().session?.id === sessionId) {
      get().closeTab(sessionId);
    } else {
      evictSessionFromTabs(set, get, sessionId);
    }
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  // B2: soft-archive — hides the session from tabs + default lists but keeps
  // every node/jsonl intact (reversible via unarchiveSession). Mirrors
  // deleteSession's "if it's the active one, clear to a fresh-conversation
  // state" so the canvas doesn't keep showing a now-hidden session.
  archiveSession: async (sessionId) => {
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    // Wave 4: an archived session is hidden from tabs, so evict it. When
    // it's the active one, closeTab handles the neighbor switch + clear.
    if (get().session?.id === sessionId) {
      get().closeTab(sessionId);
    } else {
      evictSessionFromTabs(set, get, sessionId);
    }
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  // B2: restore an archived session back into the active lists. Does not
  // auto-load it (the picker decides whether to switch); just flips the flag
  // and bumps the revision so lists/tabs refetch.
  unarchiveSession: async (sessionId) => {
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  renameSession: async (sessionId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    // Optimistic update: patch the locally-loaded session if it matches,
    // and bump revision so SessionPicker refetches its list.
    const prevSession = get().session;
    if (prevSession?.id === sessionId) {
      set({ session: { ...prevSession, title: trimmed, updatedAt: Date.now() } });
    }
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        // Revert optimistic update on failure.
        if (prevSession?.id === sessionId) set({ session: prevSession });
        const text = await res.text().catch(() => "");
        throw new Error(`rename failed: ${res.status} ${text}`);
      }
      const { session } = (await res.json()) as { session: Session };
      // Server is source of truth (e.g. server may have trimmed/truncated).
      if (get().session?.id === sessionId) set({ session });
    } finally {
      set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
    }
  },

  setNodePosition: (nodeId, pos) => {
    set((s) => {
      const n = s.nodes[nodeId];
      if (!n) return s;
      return { nodes: { ...s.nodes, [nodeId]: { ...n, position: pos } } };
    });
  },

  setActiveNode: (nodeId) => {
    if (nodeId) {
      get().expandAncestors(nodeId);
      stampTreeVisit(set, get, nodeId);
      // 显式导航到手动标未读的节点 = 「点开了」，解除自动已读抑制。
      if (get().unreadHolds[nodeId]) {
        set((s) => {
          const rest = { ...s.unreadHolds };
          delete rest[nodeId];
          return { unreadHolds: rest };
        });
      }
    }
    set({ activeNodeId: nodeId });
  },

  setReadingPosition: (sessionId, pos) => {
    const s = get();
    if (s.session?.id !== sessionId) return;
    const next = { nodeId: pos.nodeId, offset: Math.max(0, Math.round(pos.offset)) };
    const cur = s.readingPosition;
    if (cur && cur.nodeId === next.nodeId && cur.offset === next.offset) return;
    set({ readingPosition: next });
  },

  setViewMode: (mode) => {
    if (mode === "canvas") {
      // Returning to canvas: pan to the most-recently-edited node so the
      // user lands on the freshest work, not whatever the previous
      // viewport was. Falls back to whatever the user was reading if we
      // have no edit record yet (e.g. straight after a page reload with
      // no nodes touched since).
      const { lastEditedNodeId, nodes, activeNodeId } = get();
      let focus =
        lastEditedNodeId && nodes[lastEditedNodeId]
          ? lastEditedNodeId
          : activeNodeId;

      // If focus is in a hidden tree, prefer focusing on a visible tree node
      if (focus && nodes[focus]) {
        let root = nodes[focus];
        while (root.parentId && nodes[root.parentId]) {
          root = nodes[root.parentId];
        }
        if (root.hiddenAt !== null) {
          const visibleRoots = Object.values(nodes).filter(
            (n) => !n.parentId && n.hiddenAt === null,
          );
          if (visibleRoots.length > 0) {
            focus = visibleRoots[0].id;
          }
        }
      }

      if (focus) get().expandAncestors(focus);
      set({ viewMode: "canvas", activeNodeId: focus });
      return;
    }
    set({ viewMode: mode });
  },

  setStreamAlert: (message) => set({ streamAlert: message }),

  setProvider: (provider) => {
    set({ provider });
    if (typeof window !== "undefined") {
      // Global value = the default model for NEW sessions.
      window.localStorage.setItem(PROVIDER_KEY, provider);
    }
    // If a session is active, this also becomes that session's locked model:
    // mirror it into the in-memory row immediately, then persist (fire-and-
    // forget — local state already updated optimistically). This is what makes
    // the choice stick when the user switches away and back.
    const sid = get().session?.id;
    if (sid) {
      set((s) =>
        s.session && s.session.id === sid
          ? { session: { ...s.session, model: provider } }
          : {},
      );
      if (typeof window !== "undefined") {
        void fetch(`/api/sessions/${sid}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: provider }),
        }).catch(() => {});
      }
    }
  },

  fetchProviderCatalog: async () => {
    try {
      const res = await fetchWithTimeout("/api/providers", 5000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { providers } = (await res.json()) as { providers: ProviderInfo[] };
      if (providers.length > 0) set({ providerCatalog: providers });
    } catch (err) {
      // Fetch failed (offline/first-boot race/etc) — keep the static
      // PROVIDERS fallback already seeded at store creation, don't blank it.
      console.error("[trellis] fetchProviderCatalog failed:", err);
    }
  },

  setDraftMode: (mode) => {
    set({ draftMode: mode });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_KEY, mode);
    }
  },

  setDraftWorkspacePath: (path) => {
    set({ draftWorkspacePath: path });
    if (typeof window !== "undefined") {
      if (path) window.localStorage.setItem(WORKSPACE_KEY, path);
      else window.localStorage.removeItem(WORKSPACE_KEY);
    }
  },

  setDraftAgentId: (id) => {
    const v = id && id.trim() ? id : null;
    set({ draftAgentId: v });
    if (typeof window !== "undefined") {
      if (v) window.localStorage.setItem(AGENT_KEY, v);
      else window.localStorage.removeItem(AGENT_KEY);
    }
  },

  setDraftSystemPrompt: (prompt) => {
    const v = prompt && prompt.trim() ? prompt : null;
    set({ draftSystemPrompt: v });
    if (typeof window !== "undefined") {
      if (v) window.localStorage.setItem(SYSTEM_PROMPT_KEY, v);
      else window.localStorage.removeItem(SYSTEM_PROMPT_KEY);
    }
  },

  setSendKey: (key) => {
    set({ sendKey: key });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SEND_KEY_KEY, key);
    }
  },

  setThreadWidth: (width) => {
    set({ threadWidth: width });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THREAD_WIDTH_KEY, width);
    }
  },

  setTreePanelView: (view) => {
    set({ treePanelView: view });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TREE_PANEL_VIEW_KEY, view);
    }
  },

  setHistoryDepth: (n) => {
    const v = clampDepth(n);
    set({ historyDepth: v });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(HISTORY_DEPTH_KEY, String(v));
    }
  },

  setChatEnhanced: (v) => {
    set({ chatEnhanced: v });
    if (typeof window !== "undefined") {
      if (v) window.localStorage.setItem(CHAT_ENHANCED_KEY, "1");
      else window.localStorage.removeItem(CHAT_ENHANCED_KEY);
    }
  },

  setDraftRequireApproval: (v) => {
    set({ draftRequireApproval: v });
    if (typeof window !== "undefined") {
      if (v) window.localStorage.setItem(REQUIRE_APPROVAL_KEY, "1");
      else window.localStorage.removeItem(REQUIRE_APPROVAL_KEY);
    }
  },

  editNode: async (nodeId, newQuestion) => {
    const node = get().nodes[nodeId];
    if (!node) return;
    const q = newQuestion.trim();
    if (!q) return;
    // A2 (roadmap Q1 = B): editing a question re-asks with the same lineage
    // as a NEW sibling — the original Q&A is preserved, tree stays
    // append-only (no destructive in-place edit / downstream wipe).
    if (node.parentId) {
      await get().streamBranch(node.parentId, q, node.parentAnchor ?? null);
    } else {
      await get().streamRoot(q, { attachToCurrentSession: true });
    }
  },

  streamRoot: async (question, opts) => {
    const {
      provider,
      draftMode,
      draftWorkspacePath,
      draftSystemPrompt,
      draftAgentId,
      session,
    } = get();
    const sessionId = opts?.attachToCurrentSession ? session?.id : undefined;
    // Mode + workspace + systemPrompt are only sent when creating a new
    // session. When attaching to an existing session, the server reads them
    // from the locked session row. systemPrompt only applies to chat mode.
    const modeFields = sessionId
      ? {}
      : {
          mode: draftMode,
          workspacePath: draftWorkspacePath,
          // S88: 选了 agent 就以 agent 为准，systemPrompt 不再发 —— 服务端
          // applyAgent 也会删掉它，这里不发是为了让「发出去的东西」和「生效的
          // 东西」一致，省得日后对着 network 面板怀疑人生。
          ...(draftAgentId ? { agentId: draftAgentId } : {}),
          ...(!draftAgentId && draftMode === "chat" && draftSystemPrompt
            ? { systemPrompt: draftSystemPrompt }
            : {}),
          // 权限确认：仅 project 有意义；服务端还会按 provider
          // family 再钳一道（codex/mock 落 false）。
          ...(draftMode !== "chat" && get().draftRequireApproval
            ? { requireApproval: true }
            : {}),
        };
    const attachments = opts?.attachments;
    // #6: attaching to an existing session renders inside a live view →
    // optimistic placeholder card. Brand-new sessions stay on the composer
    // screen until `created` (QuestionInput owns that busy state).
    const optimisticId = sessionId
      ? insertOptimisticNode(set, get, {
          sessionId,
          parentId: null,
          question,
          anchor: null,
          attachments,
          focus: true,
        })
      : null;
    const controller = new AbortController();
    try {
      await runStream(
        {
          kind: "root",
          question,
          provider,
          sessionId,
          chatEnhanced: get().chatEnhanced,
          ...modeFields,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
        handleStreamEvent(set, get, { controller, optimisticId }),
        controller.signal,
      );
    } finally {
      releaseStreamController(controller);
      // Safety net: the stream ended without `created` ever replacing the
      // placeholder (SSE dropped pre-created). Remove it + surface why.
      if (optimisticId) {
        discardOptimisticNode(
          set,
          get,
          optimisticId,
          "连接中断：问题可能没有发出，请重试",
        );
      }
    }
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  streamBranch: async (parentId, question, anchor, opts) => {
    const { provider, session } = get();
    // For selection-anchored branches (anchor !== null), keep the user on the
    // parent so they can keep reading; the new child streams in the
    // background and is reachable via the inline <mark>. For plain
    // followups (anchor === null), behave like before — auto-focus the new
    // child so the user sees the response.
    const focusNew = anchor === null;
    const attachments = opts?.attachments;
    // #6: optimistic placeholder — the card (question + "生成中" dots) pops
    // the moment the user submits; `created` swaps in the server node.
    const optimisticId = session
      ? insertOptimisticNode(set, get, {
          sessionId: session.id,
          parentId,
          question,
          anchor,
          attachments,
          focus: focusNew,
        })
      : null;
    const controller = new AbortController();
    try {
      await runStream(
        {
          kind: "branch",
          parentNodeId: parentId,
          question,
          parentAnchor: anchor,
          provider,
          historyDepth: get().historyDepth,
          chatEnhanced: get().chatEnhanced,
          // S88 @提及：这一轮定向派给某个 agent（单轮，主线人格不变）。
          ...(opts?.mentionAgentSlug ? { mentionAgentSlug: opts.mentionAgentSlug } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
        handleStreamEvent(set, get, { focusNew, controller, optimisticId }),
        controller.signal,
      );
    } finally {
      releaseStreamController(controller);
      if (optimisticId) {
        discardOptimisticNode(
          set,
          get,
          optimisticId,
          "连接中断：问题可能没有发出，请重试",
        );
      }
    }
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  retryNode: async (nodeId) => {
    const { provider } = get();
    // Optimistically reset the local node so the UI flips back to the
    // streaming state immediately. The server's "created" event will
    // overwrite this with the canonical reset row.
    set((s) => {
      const n = s.nodes[nodeId];
      if (!n) return s;
      return {
        nodes: {
          ...s.nodes,
          [nodeId]: {
            ...n,
            response: "",
            status: "streaming",
            errorMessage: null,
            tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            // Retry wipes the panel — server clears tool_calls_json
            // in resetNodeForRetry; mirror locally so the UI doesn't
            // briefly show stale entries during the network round-trip.
            toolCalls: [],
            // A路②: server also clears pending_interaction_json on retry.
            pendingInteraction: null,
          },
        },
        // 重跑后旧的 "等你回答" 提醒随之过时。
        doneToasts: s.doneToasts.filter(
          (t) => !(t.nodeId === nodeId && t.kind === "waiting"),
        ),
        lastEditedNodeId: nodeId,
      };
    });
    // 写即复活的本地镜像（服务端 resetNodeForRetry 同步清树根 hidden_at）。
    reviveTreeLocally(set, get, nodeId);
    // Retry knows the nodeId up front, so we can register the controller
    // immediately — no need to wait for the `created` event.
    const controller = new AbortController();
    STREAM_CONTROLLERS.set(nodeId, controller);
    try {
      await runStream(
        { kind: "retry", nodeId, provider, historyDepth: get().historyDepth, chatEnhanced: get().chatEnhanced },
        handleStreamEvent(set, get, { controller }),
        controller.signal,
      );
    } finally {
      // Defensive: handleStreamEvent's terminal branches also delete; this
      // covers the case where runStream throws before any event arrives.
      if (STREAM_CONTROLLERS.get(nodeId) === controller) {
        STREAM_CONTROLLERS.delete(nodeId);
      }
    }
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  loadNodeToolCalls: async (nodeId) => {
    const n = get().nodes[nodeId];
    // 已有全量数据（流式节点 / 单节点端点带回来的）就不必再拉。
    if (!n || n.toolCalls.length > 0) return;
    if (get().toolCallsLoading[nodeId]) return;
    set((s) => ({
      toolCallsLoading: { ...s.toolCallsLoading, [nodeId]: true },
    }));
    try {
      const res = await fetchWithTimeout(
        `/api/nodes/${nodeId}/tool-calls`,
        5000,
      );
      if (!res.ok) return;
      const { toolCalls } = (await res.json()) as { toolCalls?: ToolCall[] };
      if (!Array.isArray(toolCalls)) return;
      set((s) => {
        const cur = s.nodes[nodeId];
        // 拉取期间节点被换过（重跑 / 切会话）就别往旧节点上盖。
        if (!cur || cur.toolCalls.length > 0) return s;
        return {
          nodes: { ...s.nodes, [nodeId]: { ...cur, toolCalls } },
        };
      });
    } catch {
      // 拉取失败静默降级：角标统计还在，只是展开动线没内容。下次展开重试。
    } finally {
      set((s) => ({
        toolCallsLoading: { ...s.toolCallsLoading, [nodeId]: false },
      }));
    }
  },

  abortStream: (nodeId) => {
    // #6: optimistic placeholder — no server run exists yet, nothing to
    // abort. The stop affordances disable themselves in this window; this
    // guard keeps stray calls from posting to a nonexistent node.
    if (isOptimisticNodeId(nodeId)) return;
    // Stage 17: the SSE reader's local AbortController no longer kills
    // the spawn — it only unsubscribes us from the bus. To actually
    // stop the run we POST /api/chat/[id]/abort, which calls
    // run-bus.abortRun(). The server-side terminal event then flows
    // back through our subscription, drives handleStreamEvent's error
    // branch, and unwinds STREAM_CONTROLLERS naturally.
    //
    // We still abort the local controller so the SSE reader winds down
    // immediately even if the network path back from the server is
    // slow. The synthesized "aborted" error event in runStream's catch
    // gives instant UI feedback that matches the eventual server state.
    void fetch(`/api/chat/${nodeId}/abort`, { method: "POST" }).catch(() => {
      // Network gone — local abort still updates UI. Server-side will
      // clean up via reapInterruptedStreams on next restart at worst.
    });
    const ctrl = STREAM_CONTROLLERS.get(nodeId);
    if (ctrl) ctrl.abort();
    // Recovery affordance: surface a toast offering one-click re-run, so a
    // stop (especially a stray Esc) is instantly recoverable.
    const aborted = get().nodes[nodeId];
    set({
      abortArm: null,
      abortRecovery: {
        nodeId,
        label: aborted
          ? aborted.topicLabel ?? aborted.question.slice(0, 40)
          : "",
      },
    });
    // Don't delete here — the terminal branch in handleStreamEvent will,
    // once the SSE response actually winds down. Keeping it lets a
    // double-press of Esc be a no-op instead of finding a stale entry.
  },

  hasStreamingNode: () => STREAM_CONTROLLERS.size > 0,

  reconnectStreamingNodes: () => {
    const { nodes } = get();
    for (const n of Object.values(nodes)) {
      if (n.status !== "streaming") continue;
      // Optimistic placeholders have no server row to reconnect to.
      if (isOptimisticNodeId(n.id)) continue;
      if (RECONNECT_HANDLES.has(n.id)) continue;
      // A live POST /api/chat reader is still consuming the same server
      // run-bus we'd attach to. Opening a second SSE here would make every
      // delta arrive twice — both subscribers feed emitStream, so the bus
      // pending buffer accumulates each chunk twice and the DOM streamRef
      // writes each chunk twice (visible as "ABCAB" interleaved doubling).
      // If the POST is actually dead, its reader will hit done/error and
      // clear its STREAM_CONTROLLERS entry — the next visibilitychange or
      // online event retries.
      if (STREAM_CONTROLLERS.has(n.id)) continue;
      void attachReconnectStream(n.id, set, get);
    }
  },

  latestStreamingNodeId: () => {
    let last: string | null = null;
    for (const id of STREAM_CONTROLLERS.keys()) last = id;
    return last;
  },

  createReference: async (input) => {
    const currentSession = get().session;
    const { provider } = get();
    const baseBody =
      input.sourceType === "paste"
        ? {
            sourceType: "paste",
            pastedText: input.pastedText,
            title: input.title,
            provider,
          }
        : { sourceType: "url", url: input.url, provider };
    const body = currentSession
      ? { ...baseBody, sessionId: currentSession.id }
      : baseBody;

    if (input.sourceType === "paste") {
      // Paste flow stays synchronous JSON.
      const res = await fetch("/api/references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `HTTP ${res.status}: ${text || "create reference failed"}`,
        );
      }
      const { session, node } = (await res.json()) as {
        session?: Session;
        node: ApiNode;
      };
      const local = apiNodeToChatNode(node);
      set((s) => {
        const next: Partial<State> = {
          nodes: session
            ? { [local.id]: local }
            : { ...s.nodes, [local.id]: local },
          activeNodeId: local.id,
          sessionsRevision: s.sessionsRevision + 1,
          lastEditedNodeId: local.id,
        };
        if (session) {
          next.session = session;
          next.viewMode = defaultViewModeForSession(session);
        } else if (s.session) next.session = { ...s.session, updatedAt: Date.now() };
        return next;
      });
      return local;
    }

    // URL flow: SSE. Server pre-creates a `streaming` placeholder node so
    // it appears on the canvas immediately. The action's promise resolves
    // as soon as that `created` event arrives — the caller (picker) can
    // close itself and let the user watch progress on the card. Claude's
    // remaining events keep flowing into the store after this returns.
    return new Promise<ChatNode>((resolve, reject) => {
      const controller = new AbortController();
      let assignedNodeId: string | null = null;
      let resolved = false;

      const cleanup = () => {
        if (assignedNodeId) {
          STREAM_CONTROLLERS.delete(assignedNodeId);
          set((s) => {
            if (!assignedNodeId) return s;
            if (!(assignedNodeId in s.fetchProgress)) return s;
            const next = { ...s.fetchProgress };
            delete next[assignedNodeId];
            return { fetchProgress: next };
          });
        }
      };

      const fail = (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(e);
        } else if (assignedNodeId && !controller.signal.aborted) {
          const id = assignedNodeId;
          set((s) => {
            const n = s.nodes[id];
            if (!n) return s;
            return {
              nodes: {
                ...s.nodes,
                [id]: { ...n, status: "error", errorMessage: e.message },
              },
            };
          });
          cleanup();
        }
      };

      (async () => {
        let res: Response;
        try {
          res = await fetch("/api/references", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          fail(err);
          return;
        }
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          fail(new Error(`HTTP ${res.status}: ${text || "create failed"}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const raw = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (!raw.startsWith("data: ")) continue;
              const event = safeParseJson(raw.slice(6));
              if (!event) continue;
              handleRefStreamEvent(event, set, get, {
                controller,
                onAssigned: (id, local) => {
                  assignedNodeId = id;
                  STREAM_CONTROLLERS.set(id, controller);
                  // Resolve the outer promise as soon as the placeholder
                  // is in the store — picker closes here.
                  if (!resolved) {
                    resolved = true;
                    resolve(local);
                  }
                },
                onResolved: () => {
                  // `done` event — store already updated; just clean up.
                  cleanup();
                },
                onTerminalError: (msg) => {
                  if (!resolved) {
                    resolved = true;
                    reject(new Error(msg));
                  }
                  cleanup();
                },
              });
            }
          }
        } catch (err) {
          fail(err);
          return;
        }
        // Stream ended without an explicit terminal — if we never
        // resolved, surface as an error.
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error("流式响应结束但没有 created 事件"));
        }
      })();
    });
  },

  jumpToParentAtAnchor: (parentId, childId) => {
    get().expandAncestors(parentId);
    stampTreeVisit(set, get, parentId);
    set({
      pendingScrollAnchor: { nodeId: parentId, kind: "child", childId },
      activeNodeId: parentId,
    });
  },

  jumpToNoteSource: (noteId) => {
    const note = get().notes.find((n) => n.id === noteId);
    if (!note) return;
    get().expandAncestors(note.sourceNodeId);
    stampTreeVisit(set, get, note.sourceNodeId);
    set({
      pendingScrollAnchor: {
        nodeId: note.sourceNodeId,
        kind: "note",
        noteId,
      },
      activeNodeId: note.sourceNodeId,
      viewMode: "linear",
      notesOpen: false,
    });
  },

  jumpToSearchHit: async ({ sessionId, nodeId, matchText, matchKind }) => {
    const cur = get().session;
    // Cross-session jump: load first, then focus. loadSessionInternal
    // wipes activeNodeId etc., so any pre-set anchor would be clobbered
    // — that's why we set the anchor *after* the load resolves.
    if (cur?.id !== sessionId) {
      await loadSessionInternal(sessionId, set);
      // Mirror loadSession: re-attach SSE for any node still streaming in the
      // jumped-to session (loadSessionInternal may have torn a stale one down).
      get().reconnectStreamingNodes();
      // Surface the jumped-to session as a tab (mirror hydrate). Without this
      // the strip keeps showing the previous preview while a different session
      // is active — the tab bar desyncs from what's on screen. On mobile this
      // is the ONLY cross-session entry (the sidebar is hidden), so a jump that
      // doesn't open a tab leaves the user unable to switch sessions at all.
      set((s) => ({
        previewSessionId: s.pinnedSessionIds.includes(sessionId)
          ? s.previewSessionId
          : sessionId,
      }));
    }
    get().expandAncestors(nodeId);
    stampTreeVisit(set, get, nodeId);
    set({
      activeNodeId: nodeId,
      viewMode: "linear",
      pendingScrollAnchor: { nodeId, kind: "search", matchText, matchKind },
    });
  },

  openNodeInSession: async (sessionId, nodeId) => {
    if (get().session?.id !== sessionId) {
      await get().previewSession(sessionId);
      // 载入期间用户又点了别处（loadSeq 竞态，旧 load 被丢弃）—— 目标会话
      // 没落成就别把锚点设到另一个会话的节点上。
      if (get().session?.id !== sessionId) return;
    }
    // 节点已被删而最近分组还没刷新：留在会话里，不设失效锚点。
    if (!get().nodes[nodeId]) return;
    get().setActiveNode(nodeId);
  },

  clearScrollAnchor: () => set({ pendingScrollAnchor: null }),

  dismissDoneToast: (nodeId) =>
    set((s) => ({
      doneToasts: s.doneToasts.filter((t) => t.nodeId !== nodeId),
    })),
  setAbortArm: (v) => set({ abortArm: v }),
  setAbortRecovery: (v) => set({ abortRecovery: v }),

  addNote: async (sourceNodeId, quotedText) => {
    const session = get().session;
    if (!session) throw new Error("no active session");
    const trimmed = quotedText.trim();
    if (!trimmed) throw new Error("quoted text is empty");
    // Optimistic: prepend with a temp id so the drawer immediately shows
    // the new note. Swap in the real id once the server responds; on
    // failure, drop the optimistic row and rethrow so the trigger UI can
    // surface a toast / inline error.
    const tempId = `temp-${uuid()}`;
    const optimistic: Note = {
      id: tempId,
      sessionId: session.id,
      sourceNodeId,
      quotedText: trimmed,
      createdAt: Date.now(),
    };
    set((s) => ({ notes: [optimistic, ...s.notes] }));
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          sourceNodeId,
          quotedText: trimmed,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text || "create note failed"}`);
      }
      const { note } = (await res.json()) as { note: Note };
      set((s) => ({
        notes: s.notes.map((n) => (n.id === tempId ? note : n)),
      }));
      return note;
    } catch (err) {
      set((s) => ({ notes: s.notes.filter((n) => n.id !== tempId) }));
      throw err;
    }
  },

  deleteNote: async (noteId) => {
    const before = get().notes;
    // Optimistic removal — drawer reflects the click instantly.
    set((s) => ({ notes: s.notes.filter((n) => n.id !== noteId) }));
    try {
      const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        // 404 is fine (already gone, double-tap, etc.)
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      // Rollback on network failure — the note is still on the server.
      set({ notes: before });
    }
  },

  setNotesOpen: (open) => set({ notesOpen: open }),
  setSearchOpen: (open) => set({ searchOpen: open }),
  openFilePreview: (absPath) =>
    set({ filePreview: { path: absPath, name: absPath.split("/").pop() || absPath } }),
  closeFilePreview: () => set({ filePreview: null }),
  setWorkspaceFilesOpen: (open) => set({ workspaceFilesOpen: open }),
  setOutlineOpen: (open) => set({ outlineOpen: open }),
  setMobileTreePanelOpen: (open) => set({ mobileTreePanelOpen: open }),
  setComposeRootOpen: (open) => set({ composeRootOpen: open }),

  deleteNode: async (nodeId) => {
    const state = get();
    const target = state.nodes[nodeId];
    if (!target) return null;
    if (state.session?.rootNodeId === nodeId) return null;
    if (target.status === "streaming") return null;

    const ids = subtreeIds(nodeId, state.nodes);
    const idsSet = new Set(ids);
    // If anything in the subtree is still streaming, abort first — the
    // server would refuse and we'd thrash the optimistic state.
    for (const id of ids) {
      if (state.nodes[id]?.status === "streaming") return null;
    }

    const prevNodes = state.nodes;
    const prevNotes = state.notes;
    const prevActive = state.activeNodeId;
    const prevCollapsed = state.collapsedNodeIds;

    const nextNodes: Record<string, ChatNode> = {};
    for (const [k, v] of Object.entries(state.nodes)) {
      if (!idsSet.has(k)) nextNodes[k] = v;
    }
    const nextNotes = state.notes.filter((n) => !idsSet.has(n.sourceNodeId));
    let nextCollapsed = state.collapsedNodeIds;
    if ([...state.collapsedNodeIds].some((id) => idsSet.has(id))) {
      nextCollapsed = new Set(
        [...state.collapsedNodeIds].filter((id) => !idsSet.has(id)),
      );
    }
    let nextActive = state.activeNodeId;
    if (state.activeNodeId && idsSet.has(state.activeNodeId)) {
      nextActive = target.parentId ?? null;
    }
    // Drop lastEditedNodeId if it sits inside the cascade — otherwise
    // setViewMode("canvas") would later try to pan to a node that no
    // longer exists. Fall back to the deleted subtree's parent if
    // possible so the user still lands near where the edit happened.
    const prevLastEdited = state.lastEditedNodeId;
    let nextLastEdited = prevLastEdited;
    if (prevLastEdited && idsSet.has(prevLastEdited)) {
      nextLastEdited = target.parentId ?? null;
    }

    set({
      nodes: nextNodes,
      notes: nextNotes,
      collapsedNodeIds: nextCollapsed,
      activeNodeId: nextActive,
      lastEditedNodeId: nextLastEdited,
    });
    if (nextCollapsed !== prevCollapsed) {
      persistCollapsed(state.session?.id, nextCollapsed);
    }

    try {
      const res = await fetch(`/api/nodes/${nodeId}`, { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text || "delete failed"}`);
      }
      const body = (await res.json()) as {
        deletedNodeIds: string[];
        deletedNoteIds: string[];
      };
      set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
      return body;
    } catch (err) {
      set({
        nodes: prevNodes,
        notes: prevNotes,
        collapsedNodeIds: prevCollapsed,
        activeNodeId: prevActive,
        lastEditedNodeId: prevLastEdited,
      });
      if (nextCollapsed !== prevCollapsed) {
        persistCollapsed(state.session?.id, prevCollapsed);
      }
      throw err;
    }
  },

  toggleCollapse: (nodeId) => {
    const { collapsedNodeIds, session } = get();
    const next = new Set(collapsedNodeIds);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    set({ collapsedNodeIds: next });
    persistCollapsed(session?.id, next);
  },

  expandAncestors: (nodeId) => {
    const { nodes, collapsedNodeIds, session } = get();
    if (collapsedNodeIds.size === 0) return;
    const ancestors = ancestorsOf(nodeId, nodes);
    if (ancestors.length === 0) return;
    let changed = false;
    const next = new Set(collapsedNodeIds);
    for (const a of ancestors) {
      if (next.delete(a)) changed = true;
    }
    if (!changed) return;
    set({ collapsedNodeIds: next });
    persistCollapsed(session?.id, next);
  },

  markNodeRead: async (nodeId) => {
    // 无条件撤 hold：手动/自动标已读都意味着「读了」，抑制没有存在理由。
    if (get().unreadHolds[nodeId]) {
      set((s) => {
        const rest = { ...s.unreadHolds };
        delete rest[nodeId];
        return { unreadHolds: rest };
      });
    }
    const existing = get().nodes[nodeId];
    if (!existing || existing.readAt) return;
    const optimisticAt = Date.now();
    set((s) => {
      const cur = s.nodes[nodeId];
      if (!cur || cur.readAt) return s;
      return {
        nodes: { ...s.nodes, [nodeId]: { ...cur, readAt: optimisticAt } },
      };
    });
    try {
      const res = await fetch(`/api/nodes/${nodeId}/read`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { readAt } = (await res.json()) as { readAt: number };
      // Reconcile with whatever the server actually persisted (idempotent —
      // typically equals optimisticAt, but if user already marked it from
      // another tab it'll be the older timestamp).
      set((s) => {
        const cur = s.nodes[nodeId];
        if (!cur) return s;
        return { nodes: { ...s.nodes, [nodeId]: { ...cur, readAt } } };
      });
    } catch {
      // Revert optimistic mark — best-effort, no user-facing error.
      set((s) => {
        const cur = s.nodes[nodeId];
        if (!cur || cur.readAt !== optimisticAt) return s;
        return { nodes: { ...s.nodes, [nodeId]: { ...cur, readAt: null } } };
      });
    }
  },

  markNodeUnread: async (nodeId) => {
    const existing = get().nodes[nodeId];
    if (!existing || !existing.readAt) return;
    const prevReadAt = existing.readAt;
    set((s) => {
      const cur = s.nodes[nodeId];
      if (!cur) return s;
      return {
        nodes: { ...s.nodes, [nodeId]: { ...cur, readAt: null } },
        unreadHolds: { ...s.unreadHolds, [nodeId]: true as const },
      };
    });
    try {
      const res = await fetch(`/api/nodes/${nodeId}/read`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // 回滚：恢复 readAt + 撤 hold，静默失败。仅在没被并发改动时回滚。
      set((s) => {
        const cur = s.nodes[nodeId];
        if (!cur || cur.readAt !== null) return s;
        const rest = { ...s.unreadHolds };
        delete rest[nodeId];
        return {
          nodes: { ...s.nodes, [nodeId]: { ...cur, readAt: prevReadAt } },
          unreadHolds: rest,
        };
      });
    }
  },

  refreshBookmarks: async () => {
    try {
      const res = await fetchWithTimeout("/api/bookmarks", 5000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        bookmarks?: Bookmark[];
        total?: number;
      };
      if (!Array.isArray(body.bookmarks)) return;
      const bookmarks = body.bookmarks;
      const total = typeof body.total === "number" && Number.isFinite(body.total)
        ? Math.max(bookmarks.length, Math.trunc(body.total))
        : bookmarks.length;
      set((s) => {
        const nodes = mergeBookmarkWindowIntoNodes(s.nodes, bookmarks);
        return { bookmarks, bookmarksTotal: total, nodes };
      });
    } catch {
      // Keep the last-known navigation list; focus/session changes retry.
    }
  },

  toggleBookmark: async (nodeId, requested) => {
    const before = get();
    const node = before.nodes[nodeId];
    const listed = before.bookmarks.find((bookmark) => bookmark.nodeId === nodeId);
    const wasOn = Boolean(node?.bookmarkedAt ?? listed?.bookmarkedAt);
    const on = requested ?? !wasOn;
    if (on && (!node || !before.session)) return;
    const optimisticAt = on ? Date.now() : null;
    const previousBookmarks = before.bookmarks;
    const previousTotal = before.bookmarksTotal;
    const previousNodeAt = node?.bookmarkedAt ?? null;
    const countDelta = on === wasOn ? 0 : on ? 1 : -1;
    set((s) => {
      const nextNodes = s.nodes[nodeId]
        ? {
            ...s.nodes,
            [nodeId]: { ...s.nodes[nodeId], bookmarkedAt: optimisticAt },
          }
        : s.nodes;
      const without = s.bookmarks.filter(
        (bookmark) => bookmark.nodeId !== nodeId,
      );
      const nextBookmarks =
        on && node && before.session
          ? [
              {
                nodeId,
                sessionId: node.sessionId,
                sessionTitle: before.session.title,
                question: bookmarkSummary(node.question, BOOKMARK_QUESTION_LIMIT),
                response: bookmarkSummary(node.response, BOOKMARK_RESPONSE_LIMIT),
                bookmarkedAt: optimisticAt!,
                readAt: node.readAt,
                status: node.status,
              },
              ...without,
            ]
          : without;
      return {
        nodes: nextNodes,
        bookmarks: nextBookmarks,
        bookmarksTotal: Math.max(0, s.bookmarksTotal + countDelta),
      };
    });
    try {
      const res = await fetch(`/api/nodes/${nodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookmarked: on }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { bookmarkedAt } = (await res.json()) as {
        bookmarkedAt: number | null;
      };
      set((s) => {
        const cur = s.nodes[nodeId];
        if (!cur) return s;
        return {
          nodes: { ...s.nodes, [nodeId]: { ...cur, bookmarkedAt } },
        };
      });
      await get().refreshBookmarks();
    } catch {
      set((s) => {
        const cur = s.nodes[nodeId];
        const nodes = cur
          ? {
              ...s.nodes,
              [nodeId]: { ...cur, bookmarkedAt: previousNodeAt },
            }
          : s.nodes;
        return {
          nodes,
          bookmarks: previousBookmarks,
          bookmarksTotal: previousTotal,
        };
      });
    }
  },

  setBookmarksOpen: (open) => set({ bookmarksOpen: open }),

  setTreeHidden: async (nodeId, hidden) => {
    // 客户端同样走到根 —— 面板传的本来就是根 id，这里兜底非根调用。
    const nodes = get().nodes;
    let rootId = nodeId;
    for (let i = 0; i < 1000; i++) {
      const cur: ChatNode | undefined = nodes[rootId];
      if (!cur) return;
      if (!cur.parentId) break;
      rootId = cur.parentId;
    }
    const prev = nodes[rootId]?.hiddenAt ?? null;
    const optimistic = hidden ? Date.now() : null;
    const patch = (at: number | null) =>
      set((s) => {
        const cur = s.nodes[rootId];
        if (!cur) return s;
        return { nodes: { ...s.nodes, [rootId]: { ...cur, hiddenAt: at } } };
      });
    patch(optimistic);
    try {
      const res = await fetch(`/api/nodes/${rootId}/hidden`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { hiddenAt } = (await res.json()) as { hiddenAt: number | null };
      patch(hiddenAt);
    } catch {
      patch(prev); // 回滚，静默失败
    }
  },

  renameTree: async (nodeId, title) => {
    // 客户端走到根 —— 支持传根 id 或子树任意节点 id。
    const nodes = get().nodes;
    let rootId = nodeId;
    for (let i = 0; i < 1000; i++) {
      const cur: ChatNode | undefined = nodes[rootId];
      if (!cur) return;
      if (!cur.parentId) break;
      rootId = cur.parentId;
    }
    const trimmed = title.trim();
    if (!trimmed) return;
    const prev = nodes[rootId]?.topicLabel ?? null;
    const patch = (label: string | null) =>
      set((s) => {
        const cur = s.nodes[rootId];
        if (!cur) return s;
        return { nodes: { ...s.nodes, [rootId]: { ...cur, topicLabel: label } } };
      });
    patch(trimmed);
    try {
      const res = await fetch(`/api/nodes/${rootId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicLabel: trimmed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { topicLabel } = (await res.json()) as { topicLabel: string };
      patch(topicLabel);
    } catch {
      patch(prev); // 回滚
    }
  },

  respondToInteraction: async (nodeId, toolUseId, decision) => {
    const existing = get().nodes[nodeId];
    const pending = existing?.pendingInteraction ?? null;
    // Guard: nothing to answer, or the form is already stale against a
    // different toolUseId — treat as stale so the UI dismisses it.
    const dropWaitingToast = (s: State) =>
      s.doneToasts.filter(
        (t) => !(t.nodeId === nodeId && t.kind === "waiting"),
      );
    if (!pending || pending.toolUseId !== toolUseId) {
      if (existing) {
        set((s) => {
          const cur = s.nodes[nodeId];
          if (!cur) return s;
          return {
            nodes: { ...s.nodes, [nodeId]: { ...cur, pendingInteraction: null } },
            doneToasts: dropWaitingToast(s),
          };
        });
      }
      return { ok: false, reason: "stale" };
    }
    // Optimistically clear so the form disappears immediately. Stash the
    // prior value to restore on a retryable failure.
    set((s) => {
      const cur = s.nodes[nodeId];
      if (!cur) return s;
      return {
        nodes: { ...s.nodes, [nodeId]: { ...cur, pendingInteraction: null } },
        doneToasts: dropWaitingToast(s),
      };
    });
    const restore = () =>
      set((s) => {
        const cur = s.nodes[nodeId];
        // Only restore if nothing newer took its place.
        if (!cur || cur.pendingInteraction) return s;
        return {
          nodes: { ...s.nodes, [nodeId]: { ...cur, pendingInteraction: pending } },
        };
      });
    try {
      const res = await fetch(`/api/nodes/${nodeId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolUseId,
          behavior: decision.behavior,
          updatedInput: decision.updatedInput,
          message: decision.message,
          ...(decision.alwaysAllowTool ? { alwaysAllowTool: true } : {}),
        }),
      });
      if (res.ok) return { ok: true };
      // 404 (no live run) / 409 (no pending / toolUseId mismatch): the run is
      // gone or moved on. Leave the form cleared — retrying won't help.
      if (res.status === 404 || res.status === 409) {
        return { ok: false, reason: "stale" };
      }
      // 400 / 5xx / anything else: retryable — put the form back.
      restore();
      return { ok: false, reason: "error" };
    } catch {
      // Network failure — retryable.
      restore();
      return { ok: false, reason: "error" };
    }
  },

  refreshReference: async (nodeId) => {
    const { provider } = get();
    const res = await fetch(
      `/api/references/${nodeId}/refresh?provider=${encodeURIComponent(provider)}`,
      {
        method: "POST",
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status}: ${text || "refresh reference failed"}`,
      );
    }
    const { node } = (await res.json()) as { node: ApiNode };
    const local = apiNodeToChatNode(node);
    set((s) => {
      // 串台 guard: refresh resolving after a session switch — don't graft.
      if (s.session?.id !== local.sessionId) {
        return { sessionsRevision: s.sessionsRevision + 1 };
      }
      const prev = s.nodes[local.id];
      // Preserve canvas position the user has settled on; only patch the
      // reference payload + topicLabel + fetchedAt.
      const merged: ChatNode = prev
        ? { ...local, position: prev.position }
        : local;
      return {
        nodes: { ...s.nodes, [local.id]: merged },
        sessionsRevision: s.sessionsRevision + 1,
        lastEditedNodeId: local.id,
      };
    });
  },
}));

// ---------------------------------------------------------------------------

type Setter = (
  partial:
    | (State & Actions)
    | Partial<State & Actions>
    | ((state: State & Actions) => (State & Actions) | Partial<State & Actions>),
) => void;

type Getter = () => State & Actions;

// #6: optimistic placeholder nodes. Inserted locally the instant the user
// submits (so the card + question render with zero server round-trip), then
// swapped for the server row when `created` arrives. The id prefix lets UI
// spots that need a real server row (abort, retry) detect the pre-created
// window.
const OPTIMISTIC_PREFIX = "optimistic-";

export function isOptimisticNodeId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_PREFIX);
}

function insertOptimisticNode(
  set: Setter,
  get: Getter,
  args: {
    sessionId: string;
    parentId: string | null;
    question: string;
    anchor: ParentAnchor | null;
    attachments?: NodeAttachment[];
    focus: boolean;
  },
): string {
  const id = `${OPTIMISTIC_PREFIX}${uuid()}`;
  const siblings = Object.values(get().nodes).filter(
    (n) => n.parentId === args.parentId,
  );
  const node: ChatNode = {
    id,
    sessionId: args.sessionId,
    parentId: args.parentId,
    parentAnchor: args.anchor,
    question: args.question,
    response: "",
    status: "streaming",
    errorMessage: null,
    position: { x: 0, y: 0 },
    tokenCount: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    createdAt: Date.now(),
    siblingIndex: siblings.length,
    topicLabel: null,
    kind: "qa",
    reference: null,
    readAt: null,
    attachments: args.attachments ?? [],
    toolCalls: [],
    pendingInteraction: null,
    hiddenAt: null,
  };
  set((s) => ({
    nodes: { ...s.nodes, [id]: node },
    lastEditedNodeId: id,
    ...(args.focus ? { activeNodeId: id } : {}),
  }));
  if (args.parentId) {
    get().expandAncestors(id);
    // 写即复活的本地镜像：服务端 createBranchNode 会清树根 hidden_at；
    // 这里同步乐观清掉，面板立刻把树从「已隐藏」组捞回热区。
    reviveTreeLocally(set, get, args.parentId);
  }
  return id;
}

// 树访问打点：走到 nodeId 的树根，记 lastVisitedAt 并持久化。找不到根
// （乐观节点竞态等）静默跳过。
function stampTreeVisit(set: Setter, get: Getter, nodeId: string): void {
  const s = get();
  const nodes = s.nodes;
  let rootId = nodeId;
  for (let i = 0; i < 1000; i++) {
    const cur: ChatNode | undefined = nodes[rootId];
    if (!cur) return;
    if (!cur.parentId) break;
    rootId = cur.parentId;
  }
  const visits = { ...s.treeVisits, [rootId]: Date.now() };
  set({ treeVisits: visits });
  persistTreeVisits(s.session?.id, visits);
}

// 走到树根，清本地 hiddenAt（写即复活的客户端镜像）。无雪藏时零开销。
function reviveTreeLocally(set: Setter, get: Getter, nodeId: string): void {
  const nodes = get().nodes;
  let rootId = nodeId;
  for (let i = 0; i < 1000; i++) {
    const cur: ChatNode | undefined = nodes[rootId];
    if (!cur) return;
    if (!cur.parentId) break;
    rootId = cur.parentId;
  }
  const root = nodes[rootId];
  if (!root || root.hiddenAt === null) return;
  set((s) => {
    const cur = s.nodes[rootId];
    if (!cur) return s;
    return { nodes: { ...s.nodes, [rootId]: { ...cur, hiddenAt: null } } };
  });
}

// Remove a placeholder that was never replaced by a server row. No-op when
// `created` already swapped it out. Optionally surfaces a streamAlert (pass
// null for silent removal, e.g. user-initiated abort).
function discardOptimisticNode(
  set: Setter,
  get: Getter,
  id: string,
  alertMessage: string | null,
): void {
  const s = get();
  const temp = s.nodes[id];
  if (!temp) return;
  const nodes = { ...s.nodes };
  delete nodes[id];
  set({
    nodes,
    activeNodeId: s.activeNodeId === id ? temp.parentId : s.activeNodeId,
    lastEditedNodeId:
      s.lastEditedNodeId === id ? temp.parentId : s.lastEditedNodeId,
    ...(alertMessage ? { streamAlert: alertMessage } : {}),
  });
}

// Wave 4: remove a session from every tab-tracking collection (pinned /
// preview / unread) without touching the active canvas. Used when a
// non-active session is deleted/archived out from under the workbench.
function evictSessionFromTabs(
  set: Setter,
  get: Getter,
  sessionId: string,
): void {
  const s = get();
  const nextPinned = s.pinnedSessionIds.filter((id) => id !== sessionId);
  if (nextPinned.length !== s.pinnedSessionIds.length) persistPinned(nextPinned);
  let unread = s.unreadSessionIds;
  if (unread.has(sessionId)) {
    unread = new Set(unread);
    unread.delete(sessionId);
  }
  set({
    pinnedSessionIds: nextPinned,
    previewSessionId:
      s.previewSessionId === sessionId ? null : s.previewSessionId,
    unreadSessionIds: unread,
  });
}

// Monotonic load token — only the newest in-flight load commits. Without it,
// a stale slow load (tab switch racing a cli-sync session_updated reload, or
// two rapid switches) can resolve LAST and flip the view back to the wrong
// session — the "switched to B but A's running content shows" 串台.
let loadSeq = 0;

// S117: hydrate 防重入（hydrated 变 true 之前的并发双跑，见 hydrate 注释）。
let hydrateInFlight = false;

async function loadSessionInternal(sessionId: string, set: Setter) {
  const seq = ++loadSeq;
  const res = await fetchWithTimeout(`/api/sessions/${sessionId}`, 5000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { session, nodes, notes } = (await res.json()) as {
    session: Session;
    nodes: ApiNode[];
    notes?: Note[];
  };
  // A newer load superseded this one while we were fetching — drop it.
  if (seq !== loadSeq) return;
  const map: Record<string, ChatNode> = {};
  for (const n of nodes) map[n.id] = apiNodeToChatNode(n);
  // Streaming nodes with a live LOCAL subscription need their response
  // baseline repaired — the DB snapshot overlaps what the stream-bus buffer
  // already holds, and rendering `response + pending` (TurnCard/ChatNode) or
  // committing `response + fullText` at done would DOUBLE the text:
  //   • live POST reader (send originated in this browser session): the bus
  //     buffer holds the FULL text since `created`, so the correct baseline
  //     is "" — same invariant as the created-time row.
  //   • live reconnect SSE: its baseline was a past catchup we no longer
  //     have. Tear it down + clear the bus; the reconnect pass right after
  //     this load re-attaches and gets a fresh authoritative catchup.
  for (const n of Object.values(map)) {
    if (n.status !== "streaming") continue;
    const live = STREAM_CONTROLLERS.get(n.id);
    if (!live) continue; // reconnect pass will attach cleanly
    const rec = RECONNECT_HANDLES.get(n.id);
    if (rec) {
      RECONNECT_HANDLES.delete(n.id);
      if (STREAM_CONTROLLERS.get(n.id) === rec) {
        STREAM_CONTROLLERS.delete(n.id);
      }
      rec.abort();
      clearStreamPending(n.id);
      clearStreamPending(thinkingChannel(n.id));
    } else {
      map[n.id] = { ...n, response: "" };
    }
  }
  // Drop any persisted collapse-ids that no longer correspond to a node
  // (e.g. server-side schema reset, race with delete) so the set never
  // keeps growing with garbage. Re-persist if we trimmed anything.
  const persisted = loadCollapsed(session.id);
  let collapsed = persisted;
  if (persisted.size > 0) {
    const trimmed = new Set<string>();
    for (const id of persisted) if (map[id]) trimmed.add(id);
    if (trimmed.size !== persisted.size) {
      persistCollapsed(session.id, trimmed);
      collapsed = trimmed;
    }
  }
  // No node-level updatedAt in storage, so use highest createdAt as a
  // best-effort "most recently edited" anchor for fresh session loads.
  // Subsequent live edits (stream done / retry / refresh) keep this
  // accurate; reloads fall back to this snapshot.
  let lastEditedNodeId: string | null = null;
  let bestTs = -Infinity;
  for (const n of Object.values(map)) {
    if (n.createdAt > bestTs) {
      bestTs = n.createdAt;
      lastEditedNodeId = n.id;
    }
  }
  // Restore the last-viewed position for this session (focused node + view
  // layer) so reopening lands back where the user left — not on the canvas
  // overview / root node. Falls back to no focus (canvas) when there's no
  // record or the recorded node has since been deleted.
  const savedView = loadViewState(session.id);
  // #7: viewMode is now per-session for every mode. Legacy records that only
  // carried fullScreen=true (the retired NodeFullView reader) migrate to the
  // linear thread — that's its successor surface.
  const restoredViewMode =
    savedView?.viewMode ??
    (savedView?.fullScreen ? "linear" : defaultViewModeForSession(session));
  let restoredActive: string | null = null;
  if (savedView?.activeNodeId && map[savedView.activeNodeId]) {
    restoredActive = savedView.activeNodeId;
  }
  // Reading position outlives activeNodeId: scrolling through the linear
  // thread never moves the anchor, so this is what actually encodes "the
  // card the user last looked at". Dropped if the node has been deleted.
  const restoredReading =
    savedView?.lastViewed && map[savedView.lastViewed.nodeId]
      ? savedView.lastViewed
      : null;
  // Make sure the restored node is actually visible in the canvas by
  // un-collapsing any of its ancestors that were persisted collapsed.
  if (restoredActive && collapsed.size > 0) {
    const next = new Set(collapsed);
    let changed = false;
    for (const a of ancestorsOf(restoredActive, map)) {
      if (next.delete(a)) changed = true;
    }
    if (changed) {
      persistCollapsed(session.id, next);
      collapsed = next;
    }
  }
  // 树访问打点：载入 + 按现存根修剪（根被删后条目不再堆积）。
  const savedVisits = loadTreeVisits(session.id);
  const treeVisits: Record<string, number> = {};
  let visitsTrimmed = false;
  for (const [rid, ts] of Object.entries(savedVisits)) {
    if (map[rid] && !map[rid].parentId) treeVisits[rid] = ts;
    else visitsTrimmed = true;
  }
  if (visitsTrimmed) persistTreeVisits(session.id, treeVisits);
  // Per-session model lock: adopt the loaded session's own model as the active
  // provider so switching away and back doesn't inherit the global picker.
  // Legacy rows (model === null) leave the current provider untouched.
  const sessionProvider = isProviderId(session.model) ? session.model : null;
  set({
    session,
    nodes: map,
    activeNodeId: restoredActive,
    viewMode: restoredViewMode,
    notes: notes ?? [],
    collapsedNodeIds: collapsed,
    lastEditedNodeId,
    readingPosition: restoredReading,
    treeVisits,
    ...(sessionProvider ? { provider: sessionProvider } : {}),
  });
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

type ChatRequestBody =
  | {
      kind: "root";
      question: string;
      provider: ProviderId;
      sessionId?: string;
      // Only meaningful when sessionId is absent (i.e. creating a new
      // session). Server ignores them and reads from the session row
      // otherwise.
      mode?: Mode;
      workspacePath?: string | null;
      // D1: chat-mode custom system prompt for a new session.
      systemPrompt?: string | null;
      chatEnhanced?: boolean;
      // 权限确认（new session 时锁定；服务端按 family/mode 钳制）。
      requireApproval?: boolean;
      // Stage 15: image attachments uploaded via /api/uploads. Server
      // sanitizes + caps; omitted on retry (server re-reads from DB).
      attachments?: NodeAttachment[];
    }
  | {
      kind: "branch";
      parentNodeId: string;
      question: string;
      parentAnchor: ParentAnchor | null;
      provider: ProviderId;
      historyDepth?: number;
      chatEnhanced?: boolean;
      attachments?: NodeAttachment[];
    }
  | {
      kind: "retry";
      nodeId: string;
      provider: ProviderId;
      historyDepth?: number;
      chatEnhanced?: boolean;
    };

type StreamEvent =
  | {
      type: "created";
      session?: Session;
      node: ApiNode;
    }
  | { type: "delta"; text: string }
  // Extended thinking chunk. Streams BEFORE any text delta (claude thinks
  // first — minutes under high effort). Rendered live in a dim panel, kept
  // on the stream-bus thinking channel only, dropped at done/error.
  | { type: "thinking"; text: string }
  | {
      type: "done";
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        contextTokens?: number | null;
      };
      // response 分层偏移（lib/types.ts:ChatNode.finalStart）。随终态下发，
      // done 提交时写进节点，重载前 TurnCard 就能分层渲染。
      finalStart?: number;
      durationMs?: number;
    }
  | { type: "error"; message: string }
  | { type: "topic_label"; nodeId: string; label: string }
  // 自动命名（体验 D）：post-done 会话标题生成完成（首答起题 / 每 8 节点刷新）。
  | { type: "session_title"; sessionId: string; title: string }
  // CLI 同步 Stage 2：attach 会话续聊后服务端做了身份对账（临时节点 → canonical
  // jsonl-uuid 节点），通知客户端重载该 session 拿正确的节点 id。
  | { type: "reload_session"; sessionId: string }
  // Stage 17 (durable streams): emitted by /api/nodes/[id]/stream when a
  // reconnecting subscriber joins an in-flight run. The payload is the
  // server's authoritative response-so-far + current status + tool call
  // snapshot. Client hard-syncs to it (overwrite, not append) and clears
  // the stream-bus accumulator so subsequent delta events extend from
  // this baseline.
  | {
      type: "catchup";
      response: string;
      status: "streaming" | "done" | "error";
      toolCalls: import("@/lib/types").ToolCall[];
      // Thinking accumulated so far (streaming runs only; optional because
      // the DB-fallback reconnect path doesn't carry it — run already dead).
      thinking?: string;
      // A路②: present when the run is paused on an interactive tool; the UI
      // (third knife) renders the waiting form from it. null otherwise.
      pendingInteraction?: import("@/lib/types").PendingInteraction | null;
    }
  // Stage 17 (tool visualization). Streams the lifecycle of every tool
  // claude invokes mid-turn. start arrives with input + name; done
  // arrives later with output + ok/error. Both modify the node's
  // toolCalls array by id.
  | {
      type: "tool_call_start";
      id: string;
      name: string;
      input: unknown;
      startedAt: number;
      // Stage 22: set when a sub-agent made the call; groups it under the
      // Task/Agent call with that id instead of the flat main chain.
      parentToolUseId?: string | null;
    }
  | {
      type: "tool_call_done";
      id: string;
      output: string | null;
      stderr: string | null;
      isError: boolean;
      endedAt: number;
    }
  // Stage 22: sub-agent progress / final report, merged onto the Task/Agent
  // call by id. Patch semantics — arrives repeatedly as the sub-agent works.
  | {
      type: "tool_call_update";
      id: string;
      agent: import("@/lib/types").TaskMeta;
    }
  // A路②: the run paused on an interactive tool (AskUserQuestion /
  // ExitPlanMode). interaction_required carries the prompt for the UI to
  // render a form; interaction_resolved fires once the user answered and the
  // model continues. The store mirrors these onto node.pendingInteraction so
  // a re-render / reconnect shows (or clears) the form.
  | {
      type: "interaction_required";
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "interaction_resolved"; toolUseId: string };

// 流式期间的 node patch 合批：catchup / tool_call_start / tool_call_done /
// tool_call_update 这类事件在一次 run 里能以每秒数个的速率轰过来，每个都
// 展开语法替换整个 `nodes` 对象 → 所有订阅 `s.nodes` 的视图（线性 thread、
// 画布）每事件重渲整棵树/整图。长 run（几百 tool calls、几百 KB response）
// 会把主线程卡死，表现就是「tab 点不开」。
//
// 解法：把同一帧内对同一节点的多次修改攒成一个 patch 队列，每帧最多 commit
// 一次 `set()`。终端事件（done/error/interaction_required）仍即时提交——它们
// 是状态翻转，要立刻反映在 UI 上，且不在高频路径上。
//
// patch 是 (当前节点) => 新节点 的纯函数；队列内顺序应用，所以一帧内多个
// tool_call 事件会被折叠成一次 store 通知。
type NodePatch = (n: ChatNode) => ChatNode;
const PENDING_NODE_PATCHES = new Map<string, NodePatch[]>();
let NODE_FLUSH_SCHEDULED = false;

function scheduleNodePatch(id: string, patch: NodePatch) {
  const arr = PENDING_NODE_PATCHES.get(id);
  if (arr) arr.push(patch);
  else PENDING_NODE_PATCHES.set(id, [patch]);
  if (NODE_FLUSH_SCHEDULED) return;
  NODE_FLUSH_SCHEDULED = true;
  const flush = () => {
    NODE_FLUSH_SCHEDULED = false;
    if (PENDING_NODE_PATCHES.size === 0) return;
    const batches = new Map<string, NodePatch[]>(PENDING_NODE_PATCHES);
    PENDING_NODE_PATCHES.clear();
    useSessionStore.setState((s) => {
      let nextNodes: Record<string, ChatNode> | null = null;
      for (const [nid, patches] of batches) {
        const cur = s.nodes[nid];
        if (!cur) continue;
        let merged = cur;
        for (const p of patches) merged = p(merged);
        if (merged === cur) continue;
        if (!nextNodes) nextNodes = { ...s.nodes };
        nextNodes[nid] = merged;
      }
      if (!nextNodes) return s;
      return { nodes: nextNodes };
    });
  };
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(flush);
  } else {
    Promise.resolve().then(flush);
  }
}

function handleStreamEvent(
  set: Setter,
  get: Getter,
  opts: {
    focusNew?: boolean;
    // Optional: register this controller against the nodeId when the
    // server emits `created` (root/branch flows where nodeId is unknown
    // up front). Retry registers the controller eagerly outside this
    // function and passes it here only so the terminal cleanup matches.
    controller?: AbortController;
    // Stage 17 reconnect path: nodeId is already known (the caller is
    // GET /api/nodes/[id]/stream, which doesn't emit `created`). Seed
    // currentNodeId so subsequent delta/done/error events bind to it
    // without waiting for a `created` payload that never arrives.
    seedNodeId?: string;
    // #6: id of the locally-inserted optimistic placeholder. `created`
    // removes it (the server node takes its place); a pre-created error
    // removes it too and routes the message to the global streamAlert.
    optimisticId?: string | null;
  } = {},
) {
  const focusNew = opts.focusNew ?? true;
  let currentNodeId: string | null = opts.seedNodeId ?? null;
  const cleanupController = (id: string) => {
    if (opts.controller && STREAM_CONTROLLERS.get(id) === opts.controller) {
      STREAM_CONTROLLERS.delete(id);
    }
  };
  // Streaming deltas bypass React state entirely: each token is dispatched
  // through stream-bus to the streaming node's DOM ref, while the bus also
  // accumulates the full text. Only `done` / `error` (terminal events)
  // commit into the store, so React + ReactFlow run reconciliation exactly
  // twice per stream (created + done) instead of once per token.
  return (event: StreamEvent) => {
    if (event.type === "created") {
      currentNodeId = event.node.id;
      // New stream: discard any leftover bus buffer for this id (e.g. from
      // a prior aborted retry) so accumulation starts clean.
      clearStreamPending(event.node.id);
      clearStreamPending(thinkingChannel(event.node.id));
      // Register the controller now that we know the nodeId. Retry already
      // registered eagerly with the same controller — set() is idempotent.
      if (opts.controller) {
        STREAM_CONTROLLERS.set(event.node.id, opts.controller);
      }
      const node = apiNodeToChatNode(event.node);
      set((s) => {
        // 串台 guard: the user may have switched sessions while this send was
        // in flight (send → immediately ⌘1/⌘2 to another tab). Grafting the
        // node into the CURRENT session's map would make the other tab render
        // this stream as its own (and focusNew would steal activeNodeId).
        // Skip the store commit — the run keeps going server-side; switching
        // back picks it up via loadSession + the live bus buffer. Only applies
        // when attaching to an existing session (event.session = brand-new
        // session creation, which intentionally switches the view).
        if (!event.session && s.session?.id !== node.sessionId) return s;
        const nodes = { ...s.nodes, [node.id]: node };
        // #6: the server row replaces the optimistic placeholder.
        if (opts.optimisticId) delete nodes[opts.optimisticId];
        const next: Partial<State> = {
          nodes,
          lastEditedNodeId: node.id,
        };
        if (focusNew || s.activeNodeId === opts.optimisticId) {
          next.activeNodeId = node.id;
        }
        if (event.session) {
          next.session = event.session;
          next.viewMode = defaultViewModeForSession(event.session);
          // Wave 4: a brand-new session enters the workbench as the preview
          // tab (transient) unless the user had already pinned this id.
          if (!s.pinnedSessionIds.includes(event.session.id)) {
            next.previewSessionId = event.session.id;
          }
        } else if (s.session) {
          next.session = { ...s.session, updatedAt: Date.now() };
        }
        return next;
      });
      // Brand-new children must be reachable on the canvas. Expand any
      // collapsed ancestor so the freshly streaming bubble shows up
      // instead of silently appearing inside a folded subtree.
      get().expandAncestors(node.id);
    } else if (event.type === "delta" && currentNodeId) {
      emitStream(currentNodeId, event.text);
    } else if (event.type === "thinking" && currentNodeId) {
      emitStream(thinkingChannel(currentNodeId), event.text);
    } else if (event.type === "done" && currentNodeId) {
      const id = currentNodeId;
      const fullText = getStreamPending(id);
      clearStreamPending(id);
      clearStreamPending(thinkingChannel(id));
      cleanupController(id);
      const usage = event.usage ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      };
      set((s) => {
        const n = s.nodes[id];
        if (!n) return s;
        // Toast the user when something finished out of focus. We compare
        // against the activeNodeId at the moment the done event fires
        // (rather than at toast-render time) so a fast-scrolling user who
        // moves on before done still gets a toast for what they kicked
        // off and walked away from. De-dupe by id in case retry / branch
        // cycles emit twice.
        const shouldToast = s.activeNodeId !== id;
        // Always drop any lingering waiting-toast for this node (run 终结了，
        // "等你回答"过时)；shouldToast 时再叠上 done toast。
        const others = s.doneToasts.filter((t) => t.nodeId !== id);
        const nextToasts = shouldToast
          ? [...others, { nodeId: id, emittedAt: Date.now() }]
          : others;
        return {
          nodes: {
            ...s.nodes,
            [id]: {
              ...n,
              response: n.response + fullText,
              status: "done",
              tokenCount: usage,
              durationMs:
                event.durationMs ??
                (n.createdAt ? Math.max(0, Date.now() - n.createdAt) : null),
              finalStart: event.finalStart ?? n.finalStart ?? null,
            },
          },
          doneToasts: nextToasts,
          lastEditedNodeId: id,
        };
      });
    } else if (event.type === "error") {
      if (currentNodeId) {
        const id = currentNodeId;
        const fullText = getStreamPending(id);
        clearStreamPending(id);
        clearStreamPending(thinkingChannel(id));
        cleanupController(id);
        set((s) => {
          const n = s.nodes[id];
          if (!n) return s;
          return {
            nodes: {
              ...s.nodes,
              [id]: {
                ...n,
                response: n.response + fullText,
                status: "error",
                errorMessage: event.message,
                durationMs:
                  n.durationMs ??
                  (n.createdAt ? Math.max(0, Date.now() - n.createdAt) : null),
              },
            },
            // Run 死了，"等你回答"的 waiting toast 一并过时。
            doneToasts: s.doneToasts.filter(
              (t) => !(t.nodeId === id && t.kind === "waiting"),
            ),
          };
        });
      } else {
        // #5: pre-`created` failure (fetch refused / HTTP non-2xx / server
        // died before creating the row). There's no node to carry the error
        // — drop the optimistic placeholder (if any) and surface globally so
        // the composer isn't left looking dead.
        if (opts.optimisticId) {
          discardOptimisticNode(set, get, opts.optimisticId, null);
        }
        if (event.message !== "aborted") {
          set({ streamAlert: `发送失败：${event.message}` });
        }
      }
    } else if (event.type === "topic_label") {
      // Patch the label onto the (already-done) node. Arrives ≤8s after done.
      const id = event.nodeId;
      set((s) => {
        const n = s.nodes[id];
        if (!n) return s;
        return {
          nodes: { ...s.nodes, [id]: { ...n, topicLabel: event.label } },
        };
      });
    } else if (event.type === "session_title") {
      // 自动命名（体验 D）：标题在 post-done 异步到达。当前打开的正是这个
      // session 就地改标题；sidebar/tabs 走 sessionsRevision 重拉各自列表。
      set((s) =>
        s.session?.id === event.sessionId
          ? { session: { ...s.session, title: event.title } }
          : s,
      );
      get().bumpSessionsRevision();
    } else if (event.type === "reload_session") {
      // CLI 同步 Stage 2：服务端把临时续聊节点换成了 canonical jsonl-uuid 节点。
      // 只在它就是当前 active session 时重载（否则下次切过去 loadSession 自然拿新的）。
      if (get().session?.id === event.sessionId) {
        void get().loadSession(event.sessionId);
      }
    } else if (event.type === "catchup" && currentNodeId) {
      // Reconnect path: server-authoritative snapshot of where the run
      // is right now. Overwrite the response + toolCalls and reset the
      // stream-bus accumulator so future delta events from THIS
      // connection don't double-append on top of anything stale that
      // lived in the bus.
      const id = currentNodeId;
      clearStreamPending(id);
      // Seed the thinking channel from the snapshot so a reconnecting tab
      // renders the思考期 immediately (empty string → clean channel).
      clearStreamPending(thinkingChannel(id));
      if (event.thinking) emitStream(thinkingChannel(id), event.thinking);
      // 合批提交：response + toolCalls 快照可能几百 KB，每个 catchup 都裸
      // `set()` 会让整棵树/整图重渲。攒进本帧 patch，与同帧 tool_call 事件
      // 一起 commit。
      scheduleNodePatch(id, (n) => ({
        ...n,
        response: event.response,
        toolCalls: event.toolCalls,
        // A路②: sync the paused-interaction state on reconnect so a
        // refreshed / late tab re-renders (or clears) the waiting form.
        pendingInteraction: event.pendingInteraction ?? null,
      }));
      // The terminal event (done/error) for non-streaming catchups
      // arrives in the very next iteration; nothing else to do here.
    } else if (event.type === "tool_call_start" && currentNodeId) {
      // New tool invocation. Append to node.toolCalls; if the id
      // already exists (catchup gave us a copy that the bus then
      // re-broadcast), skip — server-side de-dup is the source of
      // truth.
      const id = currentNodeId;
      scheduleNodePatch(id, (n) => {
        if (n.toolCalls.some((c) => c.id === event.id)) return n;
        return {
          ...n,
          toolCalls: [
            ...n.toolCalls,
            {
              id: event.id,
              name: event.name,
              input: event.input,
              output: null,
              stderr: null,
              status: "running",
              durationMs: null,
              startedAt: event.startedAt,
              endedAt: null,
              parentToolUseId: event.parentToolUseId ?? null,
            },
          ],
        };
      });
    } else if (event.type === "tool_call_done" && currentNodeId) {
      // Merge the result onto the existing tool call by id. If the
      // start event is missing (rare race or catchup edge), skip
      // silently — UI is informational, not contractual.
      const id = currentNodeId;
      scheduleNodePatch(id, (n) => {
        const idx = n.toolCalls.findIndex((c) => c.id === event.id);
        if (idx === -1) return n;
        const cur = n.toolCalls[idx];
        const next = n.toolCalls.slice();
        next[idx] = {
          ...cur,
          output: event.output,
          stderr: event.stderr,
          status: event.isError ? "error" : "done",
          endedAt: event.endedAt,
          durationMs: Math.max(0, event.endedAt - cur.startedAt),
        };
        return { ...n, toolCalls: next };
      });
    } else if (event.type === "tool_call_update" && currentNodeId) {
      // Background-task progress for the call that spawned it — a sub-agent,
      // a long-running Bash, or a Workflow. Merge — never replace — so a late
      // progress-only patch can't wipe a taskType/summary an earlier phase
      // already delivered (taskType only ever arrives on task_started, so a
      // replacing write would lose the one field that classifies the row).
      // Missing target = skip (same reasoning as tool_call_done above).
      const id = currentNodeId;
      scheduleNodePatch(id, (n) => {
        const idx = n.toolCalls.findIndex((c) => c.id === event.id);
        if (idx === -1) return n;
        const cur = n.toolCalls[idx];
        const next = n.toolCalls.slice();
        next[idx] = { ...cur, agent: { ...cur.agent, ...event.agent } };
        return { ...n, toolCalls: next };
      });
    } else if (event.type === "interaction_required" && currentNodeId) {
      // A路②: the run paused — stash the prompt so the UI (third knife) can
      // render a form. Idempotent: a re-broadcast with the same toolUseId
      // just overwrites with identical data.
      const id = currentNodeId;
      set((s) => {
        const n = s.nodes[id];
        if (!n) return s;
        // 与 done toast 同规：事件到达瞬间不在焦点上就提醒。waiting toast
        // 不设自动消失（run 阻塞在等用户），回答 / 终结时由 store 清除。
        const shouldToast = s.activeNodeId !== id;
        const nextToasts = shouldToast
          ? [
              ...s.doneToasts.filter((t) => t.nodeId !== id),
              { nodeId: id, emittedAt: Date.now(), kind: "waiting" as const },
            ]
          : s.doneToasts;
        return {
          nodes: {
            ...s.nodes,
            [id]: {
              ...n,
              pendingInteraction: {
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
              },
            },
          },
          doneToasts: nextToasts,
        };
      });
    } else if (event.type === "interaction_resolved" && currentNodeId) {
      // A路②: user answered (or it was denied/aborted) — clear the form. Guard
      // on toolUseId so a stale resolved for an older prompt can't wipe a
      // newer pending one.
      const id = currentNodeId;
      set((s) => {
        const n = s.nodes[id];
        if (!n || !n.pendingInteraction) return s;
        if (n.pendingInteraction.toolUseId !== event.toolUseId) return s;
        return {
          nodes: {
            ...s.nodes,
            [id]: { ...n, pendingInteraction: null },
          },
          doneToasts: s.doneToasts.filter(
            (t) => !(t.nodeId === id && t.kind === "waiting"),
          ),
        };
      });
    }
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

type RefStreamEvent =
  | { type: "created"; session?: Session; node: ApiNode }
  | { type: "progress"; nodeId: string; message: string }
  | { type: "done"; node: ApiNode }
  | { type: "error"; message: string };

function handleRefStreamEvent(
  raw: unknown,
  set: Setter,
  get: Getter,
  ctx: {
    controller: AbortController;
    onAssigned: (nodeId: string, local: ChatNode) => void;
    onResolved: () => void;
    onTerminalError: (message: string) => void;
  },
): void {
  const event = raw as RefStreamEvent;
  if (event.type === "created") {
    const local = apiNodeToChatNode(event.node);
    set((s) => {
      // 串台 guard (same as handleStreamEvent's created): don't graft a node
      // into a session the user has since switched away from.
      if (!event.session && s.session?.id !== local.sessionId) return s;
      const next: Partial<State> = {
        nodes: event.session
          ? { [local.id]: local }
          : { ...s.nodes, [local.id]: local },
        activeNodeId: local.id,
        sessionsRevision: s.sessionsRevision + 1,
        lastEditedNodeId: local.id,
      };
      if (event.session) {
        next.session = event.session;
        next.viewMode = defaultViewModeForSession(event.session);
      } else if (s.session) next.session = { ...s.session, updatedAt: Date.now() };
      return next;
    });
    get().expandAncestors(local.id);
    ctx.onAssigned(local.id, local);
  } else if (event.type === "progress") {
    set((s) => ({
      fetchProgress: { ...s.fetchProgress, [event.nodeId]: event.message },
    }));
  } else if (event.type === "done") {
    const local = apiNodeToChatNode(event.node);
    set((s) => {
      // 串台 guard: a reference finishing after a session switch must not
      // insert itself into the now-active session's map.
      if (s.session?.id !== local.sessionId) {
        return { sessionsRevision: s.sessionsRevision + 1 };
      }
      const prev = s.nodes[local.id];
      const merged: ChatNode = prev
        ? { ...local, position: prev.position }
        : local;
      return {
        nodes: { ...s.nodes, [local.id]: merged },
        sessionsRevision: s.sessionsRevision + 1,
        lastEditedNodeId: local.id,
      };
    });
    ctx.onResolved();
  } else if (event.type === "error") {
    // Fatal stream-level error (server couldn't even create the row).
    ctx.onTerminalError(event.message);
  }
}

// Stage 17: tracks reconnect SSE handles so visibility / online events
// don't double-attach. Keyed by nodeId. Aborting an entry tears down
// the SSE reader; the bus is server-side and unaffected.
const RECONNECT_HANDLES = new Map<string, AbortController>();

// Open GET /api/nodes/[id]/stream for a node that's still streaming in
// the local store. Idempotent — if a reconnect SSE is already running
// for this node, do nothing. The SSE handler shares handleStreamEvent
// with the live POST /api/chat flow; the only difference is we seed
// currentNodeId up front since the reconnect endpoint doesn't emit
// `created`.
async function attachReconnectStream(
  nodeId: string,
  set: Setter,
  get: Getter,
): Promise<void> {
  if (RECONNECT_HANDLES.has(nodeId)) return;
  const ctrl = new AbortController();
  RECONNECT_HANDLES.set(nodeId, ctrl);
  STREAM_CONTROLLERS.set(nodeId, ctrl);
  const onEvent = handleStreamEvent(set, get, {
    focusNew: false,
    controller: ctrl,
    seedNodeId: nodeId,
  });
  try {
    const res = await fetch(`/api/nodes/${nodeId}/stream`, {
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!raw.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(raw.slice(6)) as StreamEvent;
          onEvent(event);
        } catch {
          /* malformed — skip */
        }
      }
    }
  } catch {
    /* network died again — next visibility/online event will retry */
  } finally {
    if (RECONNECT_HANDLES.get(nodeId) === ctrl) {
      RECONNECT_HANDLES.delete(nodeId);
    }
    if (STREAM_CONTROLLERS.get(nodeId) === ctrl) {
      STREAM_CONTROLLERS.delete(nodeId);
    }
  }
}

async function runStream(
  body: ChatRequestBody,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // User-initiated abort: don't surface as a generic error in the UI —
    // the server-side finally block will mark the row as aborted, and
    // hydrate / live SSE catch-up will reflect that on next load.
    if (signal?.aborted) return;
    onEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!res.ok || !res.body) {
    onEvent({ type: "error", message: `HTTP ${res.status}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!raw.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(raw.slice(6)) as StreamEvent;
          onEvent(event);
        } catch {
          // ignore malformed events
        }
      }
    }
  } catch (err) {
    // Mid-stream abort: synthesize the terminal event so the UI exits
    // its streaming state immediately. The server already received the
    // /abort POST in abortStream and will write status='error' for us.
    if (signal?.aborted) {
      onEvent({ type: "error", message: "aborted" });
      return;
    }
    // Network drop (tab backgrounded on mobile, wifi blip, server
    // restart). Stage 17: don't fake a terminal — the server-side run
    // may still be alive. Leave the node in streaming state; the
    // reconnect listeners (visibilitychange / online / loadSession)
    // will pick up via GET /api/nodes/[id]/stream and replay catchup +
    // resume. The eventual terminal event will arrive through that
    // path, not this one. We do log to console so misbehaving runs
    // don't vanish silently.
    if (typeof console !== "undefined") {
      console.warn("[trellis] /api/chat SSE dropped:", err);
    }
  }
}

// Persist the active session's last-viewed position (focused node + view
// layer) on every change, so reopening / switching back restores it. A single
// module-level subscription spares the many activeNodeId / viewMode mutation
// sites (focus, jump, search, keyboard nav, view toggle…) from each
// having to remember to write. loadSessionInternal seeds the restored values
// in one atomic set(), so the first fire after a switch just re-persists the
// same state (idempotent). Optimistic placeholders never persist as the
// last-viewed node — they don't exist after the swap/discard.
if (typeof window !== "undefined") {
  // Re-base the reading position whenever the focused node changes through
  // explicit navigation within a session (canvas click, branch jump, search
  // hit, new-stream focus). Without this a stale scroll record from before
  // the navigation would win the next session-landing restore and "undo"
  // the jump the user just made. Session switches are excluded — the load
  // path seeds its own restored position, which may legitimately differ
  // from the anchor. The nodeId guard makes the nested set() terminate.
  useSessionStore.subscribe((state, prev) => {
    if (state.activeNodeId === prev.activeNodeId) return;
    if (!state.activeNodeId || !state.session) return;
    if (state.session.id !== prev.session?.id) return;
    if (state.readingPosition?.nodeId === state.activeNodeId) return;
    useSessionStore.setState({
      readingPosition: { nodeId: state.activeNodeId, offset: 0 },
    });
  });

  useSessionStore.subscribe((state, prev) => {
    const sid = state.session?.id;
    if (!sid) return;
    if (
      state.session?.id === prev.session?.id &&
      state.activeNodeId === prev.activeNodeId &&
      state.viewMode === prev.viewMode &&
      state.readingPosition === prev.readingPosition
    ) {
      return;
    }
    persistViewState(sid, {
      activeNodeId:
        state.activeNodeId && isOptimisticNodeId(state.activeNodeId)
          ? null
          : state.activeNodeId,
      viewMode: state.viewMode,
      ...(state.readingPosition &&
      !isOptimisticNodeId(state.readingPosition.nodeId)
        ? { lastViewed: state.readingPosition }
        : {}),
    });
  });
}
