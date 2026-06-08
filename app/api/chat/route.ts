import {
  isProviderId,
  DEFAULT_PROVIDER,
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
  getRootClaudeIdForNode,
} from "@/lib/server/repo";
import { startRun, subscribe } from "@/lib/server/run-bus";
import { resolveBlobPath, isAllowedMime, isValidHash } from "@/lib/server/blobs";
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

// D2: clamp the client-supplied history depth (ancestor turns folded into the
// prompt). Falls back to 4 for anything out of [1,12] or missing.
function clampDepth(n: unknown): number {
  return typeof n === "number" && n >= 1 && n <= 12 ? Math.round(n) : 4;
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
  const llm = getProvider(providerId, { mode });
  // Resolve image hashes → on-disk paths once, here. The provider
  // doesn't talk to the blobs module so it can stay free of fs lookups.
  const providerAttachments = resolveAttachments(resolvedAttachments);

  // project mode: history lives in the resumed claude session, so we don't
  // fold it into the prompt. chat/workspace still need the folded history.
  const reqDepth = clampDepth((body as { historyDepth?: number }).historyDepth);
  const chatEnhanced =
    (body as { chatEnhanced?: boolean }).chatEnhanced === true;
  const history =
    mode === "project" ? [] : buildHistoryForNode(nodeId, { maxDepth: reqDepth });
  // project mode: each root in the session owns its own claude session id
  // (post-2026-05 upgrade — was session-level before). Branches walk up
  // to find their root's id; fresh-context roots return null until their
  // first turn's session_init populates the column.
  const claudeSessionId =
    mode === "project" ? getRootClaudeIdForNode(nodeId) : null;

  // Stage 17: spawn ownership now lives in run-bus, not this handler.
  // We start the run with its own AbortController; HTTP disconnect only
  // unsubscribes us from the event broadcast — the LLM keeps running and
  // keeps writing to the DB. Late tabs / a returning mobile client pick
  // up via GET /api/nodes/[id]/stream.
  startRun({
    nodeId,
    projectModeFirstTurn: mode === "project" && !claudeSessionId,
    factory: (signal) =>
      llm.stream({
        history,
        question: questionForLLM,
        parentAnchor,
        signal,
        claudeSessionId,
        cwd: resolvedWorkspacePath,
        systemPrompt: resolvedSystemPrompt,
        chatEnhanced,
        attachments: providerAttachments,
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
