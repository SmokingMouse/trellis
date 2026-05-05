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
  createBranchNode,
  appendNodeResponse,
  finalizeNode,
  buildHistoryForNode,
  resetNodeForRetry,
  getNode,
  getSessionClaudeId,
  setSessionClaudeId,
  setNodeTopicLabel,
} from "@/lib/server/repo";

const VALID_MODES: Mode[] = ["lean", "cli-single", "cli-multi"];
function isMode(s: unknown): s is Mode {
  return typeof s === "string" && (VALID_MODES as string[]).includes(s);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatRequestRoot = {
  kind: "root";
  question: string;
  provider?: ProviderId;
  mode?: Mode;
};

type ChatRequestBranch = {
  kind: "branch";
  parentNodeId: string;
  question: string;
  parentAnchor?: { selectedText: string } | null;
  provider?: ProviderId;
  mode?: Mode;
};

type ChatRequestRetry = {
  kind: "retry";
  nodeId: string;
  provider?: ProviderId;
  mode?: Mode;
};

type ChatRequest = ChatRequestRoot | ChatRequestBranch | ChatRequestRetry;

function nid(): string {
  return crypto.randomUUID();
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
  const mode: Mode = isMode(body.mode) ? body.mode : "lean";
  const llm = getProvider(providerId, { mode });
  const now = Date.now();

  // Create the row(s) up front so the client gets ids in the first SSE event,
  // and the data is durable if the request aborts.
  let nodeId: string;
  let trellisSessionId: string;
  let createdEvent: Record<string, unknown>;
  let parentAnchor: { selectedText: string } | null = null;
  let questionForLLM: string;

  try {
    if (body.kind === "root") {
      trellisSessionId = nid();
      nodeId = nid();
      const { session, node } = createSessionWithRoot({
        sessionId: trellisSessionId,
        nodeId,
        title: body.question.slice(0, 60),
        question: body.question,
        now,
      });
      createdEvent = { type: "created", session, node };
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
      const node = createBranchNode({
        nodeId,
        parentId: body.parentNodeId,
        question: body.question,
        parentAnchor,
        now,
      });
      trellisSessionId = node.sessionId;
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
      const node = getNode(nodeId);
      if (!node) {
        return Response.json({ error: "node disappeared" }, { status: 500 });
      }
      trellisSessionId = node.sessionId;
      createdEvent = { type: "created", node };
    } else {
      return Response.json({ error: "unknown kind" }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }

  // cli-multi: history lives in the resumed claude session, so we don't fold
  // it into the prompt. lean/cli-single still need the folded history.
  const history =
    mode === "cli-multi" ? [] : buildHistoryForNode(nodeId);
  const claudeSessionId =
    mode === "cli-multi" ? getSessionClaudeId(trellisSessionId) : null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      send(createdEvent);

      let aggregated = "";
      let usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      let stoppedWith: "done" | "error" = "done";
      let errorMessage: string | undefined;

      try {
        for await (const event of llm.stream({
          history,
          question: questionForLLM,
          parentAnchor,
          signal: req.signal,
          claudeSessionId,
        })) {
          if (event.type === "delta") {
            aggregated += event.text;
            // Persist incrementally so a refresh on another device shows
            // partial progress. Cheap (single UPDATE per chunk).
            try {
              appendNodeResponse(nodeId, event.text);
            } catch {
              // ignore — best-effort
            }
            send(event);
          } else if (event.type === "done") {
            usage = event.usage ?? usage;
            send(event);
          } else if (event.type === "error") {
            stoppedWith = "error";
            errorMessage = event.message;
            send(event);
          } else if (event.type === "session_init") {
            // cli-multi only: bind this trellis session to the claude session
            // id on first turn. No-op once already bound (subsequent turns
            // resume the same id and re-emit it).
            if (mode === "cli-multi" && !claudeSessionId) {
              try {
                setSessionClaudeId(trellisSessionId, event.sessionId);
              } catch {
                // best-effort — failure here just means next turn won't
                // resume; user gets a fresh session.
              }
            }
            // Don't forward to client — it's a server-side concern.
          }
        }
      } catch (err) {
        stoppedWith = "error";
        errorMessage = err instanceof Error ? err.message : String(err);
        try {
          send({ type: "error", message: errorMessage });
        } catch {
          // Client may already be gone — best-effort.
        }
      } finally {
        // Client abort: subprocess provider kills cleanly and the loop ends
        // without an explicit error event, leaving stoppedWith="done". Catch
        // it here so DB + UI uniformly mark the row as aborted regardless of
        // which provider was used.
        if (req.signal.aborted) {
          stoppedWith = "error";
          errorMessage = "aborted";
        }
        try {
          finalizeNode({
            nodeId,
            status: stoppedWith,
            errorMessage,
            tokenInput: usage.input,
            tokenOutput: usage.output,
            tokenCacheRead: usage.cacheRead,
            tokenCacheCreation: usage.cacheCreation,
            now: Date.now(),
          });
        } catch {
          /* ignore */
        }
        // Topic label for overview rendering. Skip on error/aborted, mock
        // provider, and empty response. Holds the SSE stream open for up to
        // ~8s (TIMEOUT_MS in topic.ts) so the client can render the label
        // without a refresh. Best-effort — failure leaves topicLabel null
        // and the UI falls back to the question prefix.
        if (
          stoppedWith === "done" &&
          providerId !== "mock" &&
          aggregated.trim()
        ) {
          try {
            const label = await generateTopicLabel(
              questionForLLM,
              aggregated,
            );
            if (label) {
              setNodeTopicLabel(nodeId, label);
              try {
                send({ type: "topic_label", nodeId, label });
              } catch {
                // Client gone.
              }
            }
          } catch {
            /* best-effort */
          }
        }
        try {
          controller.close();
        } catch {
          // Already closed (e.g. client aborted mid-stream).
        }
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
