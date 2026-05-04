import { create } from "zustand";
import type { Mode, ProviderId } from "@/lib/llm";
import { DEFAULT_PROVIDER, isProviderId } from "@/lib/llm";
import type { ChatNode, ParentAnchor, Session } from "@/lib/types";
import {
  clearStreamPending,
  emitStream,
  getStreamPending,
} from "@/lib/stream-bus";

// Phase A reference creation payloads. Mirrors the server's CreateRequest
// union; keep these in sync with app/api/references/route.ts.
export type CreateReferenceInput =
  | { sourceType: "paste"; pastedText: string; title?: string }
  | { sourceType: "url"; url: string };

const PROVIDER_KEY = "trellis-provider";
const MODE_KEY = "trellis-mode";

function loadProvider(): ProviderId {
  if (typeof window === "undefined") return DEFAULT_PROVIDER;
  const stored = window.localStorage.getItem(PROVIDER_KEY);
  return isProviderId(stored) ? stored : DEFAULT_PROVIDER;
}

function isMode(s: unknown): s is Mode {
  return s === "lean" || s === "cli-single" || s === "cli-multi";
}

function loadMode(): Mode {
  if (typeof window === "undefined") return "lean";
  const stored = window.localStorage.getItem(MODE_KEY);
  // Migrate previous boolean cli-mode flag if present.
  if (stored === null) {
    const legacy = window.localStorage.getItem("trellis-cli-mode");
    if (legacy === "1") return "cli-single";
    return "lean";
  }
  return isMode(stored) ? stored : "lean";
}

// API node → client node (add position field, drop nullable distinction)
type ApiNode = Omit<ChatNode, "position" | "topicLabel"> & {
  topicLabel?: string | null;
};

function apiNodeToChatNode(n: ApiNode): ChatNode {
  return { ...n, position: { x: 0, y: 0 }, topicLabel: n.topicLabel ?? null };
}

type State = {
  session: Session | null;
  nodes: Record<string, ChatNode>;
  activeNodeId: string | null;
  hydrated: boolean;
  hydrateError: string | null;
  provider: ProviderId;
  // Context mode: lean / cli-single / cli-multi. See lib/llm/types.ts:Mode
  // for semantics. Persisted to localStorage; loaded on hydrate.
  mode: Mode;
  // Bumps every time the server's session list might have changed —
  // SessionPicker watches this to refetch.
  sessionsRevision: number;
  // Layer 3: when true, render NodeFullView in place of canvas. Mobile
  // defaults this to true after hydrate; desktop opts in via the expand
  // button on a canvas card.
  fullScreen: boolean;
  // Latest progress message per streaming reference node. Set as the
  // claude fetcher emits SSE `progress` events; cleared when the node
  // transitions to status=done. Transient — never persisted.
  fetchProgress: Record<string, string>;
  // When user clicks "↳ 从「xxx」分叉 · 点击回到父节点" we need to (a) jump
  // to the parent node and (b) scroll the parent's response body so the
  // <mark data-child-id="..."> for this child sits in view + briefly
  // pulses to draw the eye. Set by requestScrollToAnchor; consumed and
  // cleared by NodeFullView's ResponseBody.
  pendingScrollAnchor: { nodeId: string; childId: string } | null;
};

type Actions = {
  hydrate: (sessionId?: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  newConversation: () => void;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  setNodePosition: (nodeId: string, pos: { x: number; y: number }) => void;
  setActiveNode: (nodeId: string | null) => void;
  setProvider: (provider: ProviderId) => void;
  setMode: (mode: Mode) => void;
  setFullScreen: (v: boolean) => void;
  // Stream a new root question — creates session + root node on server, streams reply.
  streamRoot: (question: string) => Promise<void>;
  // Stream a new branch from an existing parent.
  streamBranch: (
    parentId: string,
    question: string,
    anchor: ParentAnchor | null,
  ) => Promise<void>;
  // Re-run an existing node in place: server keeps the same id, wipes the
  // response/usage/error, and re-streams against the original question +
  // parent context. Avoids polluting the tree with retry siblings.
  retryNode: (nodeId: string) => Promise<void>;
  // Cancel an in-flight stream. Triggers fetch abort → server marks the row
  // status="error" / errorMessage="aborted" with whatever partial response
  // was already persisted. No-op if the node has no controller registered
  // (already done, or never streamed).
  abortStream: (nodeId: string) => void;
  // True if any node currently has a registered stream controller. Used by
  // the global Esc handler to find a target without subscribing to nodes.
  hasStreamingNode: () => boolean;
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
  // Combined "go to parent + scroll its response to the mark for this
  // child" action. Sets pendingScrollAnchor first so the consumer effect
  // sees it on the next render, then flips activeNodeId.
  jumpToParentAtAnchor: (parentId: string, childId: string) => void;
  clearScrollAnchor: () => void;
};

// Module-level so identity survives store updates and is never serialized
// into Zustand state (AbortController is not safe to clone). nodeId only
// becomes known once the server emits `created`, so we register inside
// handleStreamEvent's created branch.
const STREAM_CONTROLLERS = new Map<string, AbortController>();
// Insertion-ordered list — last entry is the most recently started stream.
// Map.keys() preserves insertion order so we don't need a separate array.

export const useSessionStore = create<State & Actions>((set, get) => ({
  session: null,
  nodes: {},
  activeNodeId: null,
  hydrated: false,
  hydrateError: null,
  provider: DEFAULT_PROVIDER,
  mode: "lean",
  sessionsRevision: 0,
  fullScreen: false,
  fetchProgress: {},
  pendingScrollAnchor: null,

  hydrate: async (sessionId) => {
    set({ provider: loadProvider(), mode: loadMode() });
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
      set({ hydrated: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[trellis] hydrate failed:", err);
      set({ hydrated: true, hydrateError: message });
    }
  },

  loadSession: async (sessionId) => {
    await loadSessionInternal(sessionId, set);
  },

  newConversation: () => {
    set({ session: null, nodes: {}, activeNodeId: null });
  },

  deleteSession: async (sessionId) => {
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (get().session?.id === sessionId) {
      set({ session: null, nodes: {}, activeNodeId: null });
    }
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

  setActiveNode: (nodeId) => set({ activeNodeId: nodeId }),

  setFullScreen: (v) => set({ fullScreen: v }),

  setProvider: (provider) => {
    set({ provider });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PROVIDER_KEY, provider);
    }
  },

  setMode: (mode) => {
    set({ mode });
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_KEY, mode);
    }
  },

  streamRoot: async (question) => {
    const { provider, mode } = get();
    const controller = new AbortController();
    await runStream(
      { kind: "root", question, provider, mode },
      handleStreamEvent(set, get, { controller }),
      controller.signal,
    );
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  streamBranch: async (parentId, question, anchor) => {
    const { provider, mode } = get();
    // For selection-anchored branches (anchor !== null), keep the user on the
    // parent so they can keep reading; the new child streams in the
    // background and is reachable via the inline <mark>. For plain
    // followups (anchor === null), behave like before — auto-focus the new
    // child so the user sees the response.
    const focusNew = anchor === null;
    const controller = new AbortController();
    await runStream(
      {
        kind: "branch",
        parentNodeId: parentId,
        question,
        parentAnchor: anchor,
        provider,
        mode,
      },
      handleStreamEvent(set, get, { focusNew, controller }),
      controller.signal,
    );
    set((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));
  },

  retryNode: async (nodeId) => {
    const { provider, mode } = get();
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
            tokenCount: { input: 0, output: 0 },
          },
        },
      };
    });
    // Retry knows the nodeId up front, so we can register the controller
    // immediately — no need to wait for the `created` event.
    const controller = new AbortController();
    STREAM_CONTROLLERS.set(nodeId, controller);
    try {
      await runStream(
        { kind: "retry", nodeId, provider, mode },
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

  abortStream: (nodeId) => {
    const ctrl = STREAM_CONTROLLERS.get(nodeId);
    if (!ctrl) return;
    ctrl.abort();
    // Don't delete here — the terminal branch in handleStreamEvent will,
    // once the SSE response actually winds down. Keeping it lets a
    // double-press of Esc be a no-op instead of finding a stale entry.
  },

  hasStreamingNode: () => STREAM_CONTROLLERS.size > 0,

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
        };
        if (session) next.session = session;
        else if (s.session) next.session = { ...s.session, updatedAt: Date.now() };
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
    set({
      pendingScrollAnchor: { nodeId: parentId, childId },
      activeNodeId: parentId,
    });
  },

  clearScrollAnchor: () => set({ pendingScrollAnchor: null }),

  markNodeRead: async (nodeId) => {
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
      const prev = s.nodes[local.id];
      // Preserve canvas position the user has settled on; only patch the
      // reference payload + topicLabel + fetchedAt.
      const merged: ChatNode = prev
        ? { ...local, position: prev.position }
        : local;
      return {
        nodes: { ...s.nodes, [local.id]: merged },
        sessionsRevision: s.sessionsRevision + 1,
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

async function loadSessionInternal(sessionId: string, set: Setter) {
  const res = await fetchWithTimeout(`/api/sessions/${sessionId}`, 5000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { session, nodes } = (await res.json()) as {
    session: Session;
    nodes: ApiNode[];
  };
  const map: Record<string, ChatNode> = {};
  for (const n of nodes) map[n.id] = apiNodeToChatNode(n);
  set({ session, nodes: map, activeNodeId: null });
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

type ChatRequestBody =
  | { kind: "root"; question: string; provider: ProviderId; mode: Mode }
  | {
      kind: "branch";
      parentNodeId: string;
      question: string;
      parentAnchor: ParentAnchor | null;
      provider: ProviderId;
      mode: Mode;
    }
  | {
      kind: "retry";
      nodeId: string;
      provider: ProviderId;
      mode: Mode;
    };

type StreamEvent =
  | {
      type: "created";
      session?: Session;
      node: ApiNode;
    }
  | { type: "delta"; text: string }
  | { type: "done"; usage?: { input: number; output: number } }
  | { type: "error"; message: string }
  | { type: "topic_label"; nodeId: string; label: string };

function handleStreamEvent(
  set: Setter,
  _get: Getter,
  opts: {
    focusNew?: boolean;
    // Optional: register this controller against the nodeId when the
    // server emits `created` (root/branch flows where nodeId is unknown
    // up front). Retry registers the controller eagerly outside this
    // function and passes it here only so the terminal cleanup matches.
    controller?: AbortController;
  } = {},
) {
  const focusNew = opts.focusNew ?? true;
  let currentNodeId: string | null = null;
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
      // Register the controller now that we know the nodeId. Retry already
      // registered eagerly with the same controller — set() is idempotent.
      if (opts.controller) {
        STREAM_CONTROLLERS.set(event.node.id, opts.controller);
      }
      const node = apiNodeToChatNode(event.node);
      set((s) => {
        const next: Partial<State> = {
          nodes: { ...s.nodes, [node.id]: node },
        };
        if (focusNew) next.activeNodeId = node.id;
        if (event.session) {
          next.session = event.session;
        } else if (s.session) {
          next.session = { ...s.session, updatedAt: Date.now() };
        }
        return next;
      });
    } else if (event.type === "delta" && currentNodeId) {
      emitStream(currentNodeId, event.text);
    } else if (event.type === "done" && currentNodeId) {
      const id = currentNodeId;
      const fullText = getStreamPending(id);
      clearStreamPending(id);
      cleanupController(id);
      const usage = event.usage ?? { input: 0, output: 0 };
      set((s) => {
        const n = s.nodes[id];
        if (!n) return s;
        return {
          nodes: {
            ...s.nodes,
            [id]: {
              ...n,
              response: n.response + fullText,
              status: "done",
              tokenCount: usage,
            },
          },
        };
      });
    } else if (event.type === "error" && currentNodeId) {
      const id = currentNodeId;
      const fullText = getStreamPending(id);
      clearStreamPending(id);
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
            },
          },
        };
      });
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
  _get: Getter,
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
      const next: Partial<State> = {
        nodes: event.session
          ? { [local.id]: local }
          : { ...s.nodes, [local.id]: local },
        activeNodeId: local.id,
        sessionsRevision: s.sessionsRevision + 1,
      };
      if (event.session) next.session = event.session;
      else if (s.session) next.session = { ...s.session, updatedAt: Date.now() };
      return next;
    });
    ctx.onAssigned(local.id, local);
  } else if (event.type === "progress") {
    set((s) => ({
      fetchProgress: { ...s.fetchProgress, [event.nodeId]: event.message },
    }));
  } else if (event.type === "done") {
    const local = apiNodeToChatNode(event.node);
    set((s) => {
      const prev = s.nodes[local.id];
      const merged: ChatNode = prev
        ? { ...local, position: prev.position }
        : local;
      return {
        nodes: { ...s.nodes, [local.id]: merged },
        sessionsRevision: s.sessionsRevision + 1,
      };
    });
    ctx.onResolved();
  } else if (event.type === "error") {
    // Fatal stream-level error (server couldn't even create the row).
    ctx.onTerminalError(event.message);
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
    // Mid-stream abort throws on reader.read(). Synthesize an aborted error
    // event so the UI clears its streaming state — the server already wrote
    // the partial response + status="error"/errorMessage="aborted" before
    // the connection dropped.
    if (signal?.aborted) {
      onEvent({ type: "error", message: "aborted" });
      return;
    }
    onEvent({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
