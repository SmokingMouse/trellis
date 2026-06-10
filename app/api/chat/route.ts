import {
  isProviderId,
  DEFAULT_PROVIDER,
  providerFamily,
  type ProviderId,
  type Mode,
} from "@/lib/llm";
import { getProvider } from "@/lib/llm/server";
import { generateTopicLabel } from "@/lib/llm/topic";
import {
  createSessionWithRoot,
  createRootInSession,
  createBranchNode,
  buildHistoryForNode,
  resetNodeForRetry,
  getNode,
  getNodeAttachments,
  getSession,
  getRootResumeIdForNode,
  getParentResumeId,
} from "@/lib/server/repo";
import { startRun, subscribe } from "@/lib/server/run-bus";
import { resolveBlobPath, isAllowedMime, isValidHash } from "@/lib/server/blobs";
import { sessionCwd } from "@/lib/paths";
import type { NodeAttachment } from "@/lib/types";

const VALID_MODES: Mode[] = ["chat", "workspace", "project"];
function isMode(s: unknown): s is Mode {
  return typeof s === "string" && (VALID_MODES as string[]).includes(s);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatRequestRoot = {
  kind: "root";
  question: string;
  // When present, attach a parallel root (parent_id=NULL) to the existing
  // session instead of creating a new session. Used by the canvas "新提问"
  // entry — same investigation, fresh lineage. mode + workspacePath are
  // ignored in this branch (locked from the existing session).
  sessionId?: string;
  provider?: ProviderId;
  // mode + workspacePath only matter when creating a new session (no
  // sessionId). After creation they're locked in the DB row.
  mode?: Mode;
  workspacePath?: string | null;
  // D1: chat-mode custom system prompt for a new session. Locked at
  // creation; ignored for workspace/project (they use CLAUDE.md).
  systemPrompt?: string | null;
  // Stage 15: image attachments uploaded via /api/uploads. The client
  // sends NodeAttachment shapes; the server hash-resolves to on-disk
  // paths before handing to the provider.
  attachments?: NodeAttachment[];
};

type ChatRequestBranch = {
  kind: "branch";
  parentNodeId: string;
  question: string;
  parentAnchor?: { selectedText: string } | null;
  provider?: ProviderId;
  attachments?: NodeAttachment[];
};

type ChatRequestRetry = {
  kind: "retry";
  nodeId: string;
  provider?: ProviderId;
  // Retry intentionally has no attachments — the server re-reads the
  // node's stored attachments_json so the user doesn't have to re-pick.
};

type ChatRequest = ChatRequestRoot | ChatRequestBranch | ChatRequestRetry;

function nid(): string {
  return crypto.randomUUID();
}

// History depth knob. 0 = B-fork (append-only via --fork-session, chat+claude
// default — history lives in the forked CLI session, nothing folded into the
// prompt). 1-12 = window mode (fold N ancestor turns — the fallback, also used
// by codex chat / workspace). Anything out of [0,12] or missing → 0.
function clampDepth(n: unknown): number {
  return typeof n === "number" && n >= 0 && n <= 12 ? Math.round(n) : 0;
}

// Defensive cleanup of client-supplied attachments. Drops anything with a
// malformed hash / bad mime; preserves order and metadata of valid items.
// Hard cap of 6 — matches spec's per-node limit; further trimming the
// client missed is harmless rather than a hard fail.
function sanitizeAttachments(raw: unknown): NodeAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.hash !== "string" || !isValidHash(a.hash)) continue;
    if (typeof a.mime !== "string" || !isAllowedMime(a.mime)) continue;
    if (typeof a.size !== "number") continue;
    out.push({
      hash: a.hash,
      mime: a.mime,
      size: a.size,
      filename: typeof a.filename === "string" ? a.filename : null,
      width: typeof a.width === "number" ? a.width : undefined,
      height: typeof a.height === "number" ? a.height : undefined,
    });
    if (out.length >= 6) break;
  }
  return out;
}

// Resolve NodeAttachment[] (hash refs) to provider-ready {path, mime}.
// Drops items whose blob is missing on disk (rare but possible if the
// blobs dir got wiped between upload and submit).
function resolveAttachments(
  attachments: NodeAttachment[],
): { path: string; mime: string }[] {
  const resolved: { path: string; mime: string }[] = [];
  for (const a of attachments) {
    const r = resolveBlobPath(a.hash);
    if (r) resolved.push(r);
  }
  return resolved;
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.kind !== "retry" && !body.question?.trim()) {
    return Response.json({ error: "empty question" }, { status: 400 });
  }

  const providerId = isProviderId(body.provider)
    ? body.provider
    : DEFAULT_PROVIDER;
  const now = Date.now();

  // Create the row(s) up front so the client gets ids in the first SSE event,
  // and the data is durable if the request aborts.
  let nodeId: string;
  let trellisSessionId: string;
  let createdEvent: Record<string, unknown>;
  let parentAnchor: { selectedText: string } | null = null;
  let questionForLLM: string;
  // Resolved at session create (new root) or read from DB (everything else).
  let resolvedMode: Mode;
  let resolvedWorkspacePath: string | null;
  // D1: chat-mode system prompt, resolved the same way (new = from body,
  // everything else = from the locked session row). null = provider default.
  let resolvedSystemPrompt: string | null = null;
  // Image attachments — supplied by client for root/branch, read from
  // DB for retry. Always normalized to NodeAttachment[] before going
  // into createNode args (so they land in attachments_json) and
  // resolved to file paths for the provider call.
  let resolvedAttachments: NodeAttachment[] = [];

  try {
    if (body.kind === "root") {
      resolvedAttachments = sanitizeAttachments(body.attachments);
      if (body.sessionId) {
        // Parallel root inside an existing session — mode/workspace stay
        // locked from the existing session row, ignore any body fields.
        trellisSessionId = body.sessionId;
        const existing = getSession(trellisSessionId);
        if (!existing) {
          return Response.json({ error: "session not found" }, { status: 404 });
        }
        resolvedMode = isMode(existing.mode) ? existing.mode : "chat";
        resolvedWorkspacePath = existing.workspacePath;
        resolvedSystemPrompt = existing.systemPrompt;
        nodeId = nid();
        const node = createRootInSession({
          sessionId: trellisSessionId,
          nodeId,
          question: body.question,
          now,
          attachments: resolvedAttachments,
        });
        createdEvent = { type: "created", node };
      } else {
        // New session — body picks the mode + workspace, then locks them.
        resolvedMode = isMode(body.mode) ? body.mode : "chat";
        const wp =
          typeof body.workspacePath === "string" && body.workspacePath.trim()
            ? body.workspacePath
            : null;
        // D1: only chat mode carries a custom system prompt; clamp it away
        // for workspace/project (their persona comes from CLAUDE.md).
        if (resolvedMode === "chat") {
          const sp =
            typeof body.systemPrompt === "string" && body.systemPrompt.trim()
              ? body.systemPrompt.trim()
              : null;
          resolvedSystemPrompt = sp;
        } else {
          resolvedSystemPrompt = null;
        }
        if (resolvedMode === "chat") {
          // chat has no cwd binding; clamp any client-side workspace_path away.
          resolvedWorkspacePath = null;
        } else {
          // workspace / project require a path.
          if (!wp) {
            return Response.json(
              { error: `${resolvedMode} mode requires workspacePath` },
              { status: 400 },
            );
          }
          resolvedWorkspacePath = wp;
        }
        trellisSessionId = nid();
        nodeId = nid();
        const { session, node } = createSessionWithRoot({
          sessionId: trellisSessionId,
          nodeId,
          title: body.question.slice(0, 60),
          question: body.question,
          now,
          mode: resolvedMode,
          workspacePath: resolvedWorkspacePath,
          systemPrompt: resolvedSystemPrompt,
          model: providerId,
          attachments: resolvedAttachments,
        });
        createdEvent = { type: "created", session, node };
      }
      questionForLLM = body.question;
    } else if (body.kind === "branch") {
      if (!body.parentNodeId) {
        return Response.json(
          { error: "missing parentNodeId" },
          { status: 400 },
        );
      }
      nodeId = nid();
      parentAnchor = body.parentAnchor ?? null;
      resolvedAttachments = sanitizeAttachments(body.attachments);
      const node = createBranchNode({
        nodeId,
        parentId: body.parentNodeId,
        question: body.question,
        parentAnchor,
        now,
        attachments: resolvedAttachments,
      });
      trellisSessionId = node.sessionId;
      const parentSession = getSession(trellisSessionId);
      resolvedMode =
        parentSession && isMode(parentSession.mode) ? parentSession.mode : "chat";
      resolvedWorkspacePath = parentSession?.workspacePath ?? null;
      resolvedSystemPrompt = parentSession?.systemPrompt ?? null;
      createdEvent = { type: "created", node };
      questionForLLM = body.question;
    } else if (body.kind === "retry") {
      if (!body.nodeId) {
        return Response.json({ error: "missing nodeId" }, { status: 400 });
      }
      const reset = resetNodeForRetry(body.nodeId);
      if (!reset) {
        return Response.json({ error: "node not found" }, { status: 404 });
      }
      nodeId = body.nodeId;
      questionForLLM = reset.question;
      parentAnchor = reset.parentAnchor;
      // Retry re-uses the original node's attachments — the user
      // shouldn't have to re-attach the images they already submitted.
      resolvedAttachments = getNodeAttachments(nodeId);
      const node = getNode(nodeId);
      if (!node) {
        return Response.json({ error: "node disappeared" }, { status: 500 });
      }
      trellisSessionId = node.sessionId;
      const retrySession = getSession(trellisSessionId);
      resolvedMode =
        retrySession && isMode(retrySession.mode) ? retrySession.mode : "chat";
      resolvedWorkspacePath = retrySession?.workspacePath ?? null;
      resolvedSystemPrompt = retrySession?.systemPrompt ?? null;
      createdEvent = { type: "created", node };
    } else {
      return Response.json({ error: "unknown kind" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }

  const mode = resolvedMode;
  // Resume ids are provider-family-scoped: read/write the family-correct
  // column so a codex session can't be handed to `claude --resume`.
  const family = providerFamily(providerId);
  const llm = getProvider(providerId, { mode });
  // Resolve image hashes → on-disk paths once, here. The provider
  // doesn't talk to the blobs module so it can stay free of fs lookups.
  const providerAttachments = resolveAttachments(resolvedAttachments);

  // chat B-fork (claude only, depth 0 = default): history lives in the forked
  // CLI session — fold nothing, resume the PARENT node's session. depth>=1 or
  // codex falls back to window mode (folded history). project folds nothing
  // either (history in the resumed root session).
  const reqDepth = clampDepth((body as { historyDepth?: number }).historyDepth);
  const chatEnhanced =
    (body as { chatEnhanced?: boolean }).chatEnhanced === true;
  const chatBFork = mode === "chat" && family === "claude" && reqDepth === 0;
  // codex chat at depth 0 gets no B-fork — fold history at a sane default depth.
  const foldDepth = reqDepth === 0 ? 4 : reqDepth;
  const history =
    chatBFork || mode === "project"
      ? []
      : buildHistoryForNode(nodeId, { maxDepth: foldDepth });
  // Resume id (StreamRequest.claudeSessionId — legacy name, value is the active
  // family's resume id). project shares the ROOT's id across the whole tree
  // (getRoot…, each root owns a per-family id since the post-2026-05 upgrade).
  // chat B-fork resumes the IMMEDIATE PARENT's forked session (getParent…) so
  // each branch continues its own lineage in isolation — null on a B-fork first
  // turn (root has no parent) → fresh session, no --fork-session. For claude we
  // validate the transcript jsonl still exists (passing resolvedWorkspacePath),
  // self-healing stale/cleaned/family-polluted ids by falling back to fresh
  // instead of failing `claude --resume`.
  // claude spawns in this cwd → its session jsonl lands here, so resume
  // validation, the provider spawn, and cleanup must ALL use the same value.
  // sessionCwd centralizes the chat→scratch / workspace→bound mapping.
  const spawnCwd = sessionCwd(mode, resolvedWorkspacePath);
  const claudeSessionId =
    mode === "project"
      ? getRootResumeIdForNode(nodeId, family, spawnCwd)
      : chatBFork
        ? getParentResumeId(nodeId, family, spawnCwd)
        : null;

  // Stage 17: spawn ownership now lives in run-bus, not this handler.
  // We start the run with its own AbortController; HTTP disconnect only
  // unsubscribes us from the event broadcast — the LLM keeps running and
  // keeps writing to the DB. Late tabs / a returning mobile client pick
  // up via GET /api/nodes/[id]/stream.
  // A路②: only the claude family speaks the stdio permission protocol that
  // backs interactive tools (AskUserQuestion / ExitPlanMode). codex/mock get
  // no callback, so run-bus passes ctx.onCanUseTool=undefined and the provider
  // never opens the protocol. Pure chat (no workspace) won't trigger the
  // interactive tools, but threading the callback is harmless there.
  const interactive = family === "claude";
  startRun({
    nodeId,
    // chat B-fork writes the forked id to THIS node (per-node); project writes
    // the root-shared id on its first turn only; codex/mock/window persist none.
    sessionIdTarget: chatBFork
      ? "node"
      : mode === "project"
        ? claudeSessionId
          ? undefined
          : "root"
        : undefined,
    resumeFamily: family,
    interactive,
    factory: (signal, ctx) =>
      llm.stream({
        history,
        question: questionForLLM,
        parentAnchor,
        signal,
        claudeSessionId,
        cwd: spawnCwd,
        systemPrompt: resolvedSystemPrompt,
        chatEnhanced,
        forkSession: chatBFork,
        attachments: providerAttachments,
        onCanUseTool: ctx?.onCanUseTool,
      }),
    topicLabel:
      providerId !== "mock"
        ? (aggregated) => generateTopicLabel(questionForLLM, aggregated)
        : undefined,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // The bus doesn't know about session/node entities — the first
      // event the client sees is still the `created` payload assembled
      // up here. After that, live RunEvents flow through.
      send(createdEvent);

      const unsubscribe = subscribe(nodeId, {
        onEvent: (event) => {
          // Suppress catchup for the freshly-started run — the client
          // already has the node row (empty response) from `created`,
          // and the catchup payload would always be "" for the first
          // subscriber anyway. Reconnect endpoints DO forward catchup;
          // see GET /api/nodes/[id]/stream.
          if (event.type === "catchup") return;
          send(event);
        },
        onClose: close,
      });
      if (!unsubscribe) {
        // Shouldn't happen — we just startRun'd. Defensive close.
        close();
        return;
      }

      // HTTP disconnect: drop our subscription, but let the run continue.
      // Explicit abort goes through POST /api/chat/[id]/abort, not the
      // request signal.
      const onAbort = () => {
        unsubscribe();
        close();
      };
      if (req.signal.aborted) {
        onAbort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
