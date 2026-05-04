import {
  createReferenceNode,
  createSessionWithReference,
  finalizeReferenceFetch,
  getNode,
  type ApiNode,
  type ApiSession,
} from "@/lib/server/repo";
import { fetchUrlEvents } from "@/lib/server/fetch-url";
import {
  isProviderId,
  DEFAULT_PROVIDER,
  type ProviderId,
} from "@/lib/llm";
import type { ReferenceMeta } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// sessionId is optional. When omitted, the server creates a fresh session
// whose root node is the reference itself — mirroring the chat /api/chat
// "root" flow. Used by the empty-state QuestionInput → "+ 参考" path.
type CreatePasteRequest = {
  sessionId?: string;
  sourceType: "paste";
  pastedText: string;
  title?: string;
  provider?: ProviderId;
};

type CreateUrlRequest = {
  sessionId?: string;
  sourceType: "url";
  url: string;
  provider?: ProviderId;
};

type CreateRequest = CreatePasteRequest | CreateUrlRequest;

function nid(): string {
  return crypto.randomUUID();
}

function isCreateRequest(b: unknown): b is CreateRequest {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  if (
    o.sessionId !== undefined &&
    (typeof o.sessionId !== "string" || !o.sessionId)
  ) {
    return false;
  }
  if (o.sourceType === "paste") {
    return typeof o.pastedText === "string" && o.pastedText.length > 0;
  }
  if (o.sourceType === "url") {
    return typeof o.url === "string" && o.url.length > 0;
  }
  return false;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!isCreateRequest(body)) {
    return Response.json(
      {
        error:
          "expected { sessionId, sourceType: 'paste' | 'url', ...payload }",
      },
      { status: 400 },
    );
  }

  // Paste flow stays synchronous — no fetcher, instant. Returns a plain
  // JSON envelope like before.
  if (body.sourceType === "paste") {
    return handlePasteCreate(body);
  }
  // URL flow streams progress via SSE so the user can watch the local CLI
  // agent (claude or codex) pick a tool, run it, and assemble the
  // markdown. The reference card is pre-created in `streaming` status so
  // it appears on the canvas immediately.
  const provider: ProviderId = isProviderId(body.provider)
    ? body.provider
    : DEFAULT_PROVIDER;
  return handleUrlCreate(body, provider, req.signal);
}

async function handlePasteCreate(body: CreatePasteRequest): Promise<Response> {
  const now = Date.now();
  const nodeId = nid();
  const contentMd = body.pastedText;
  const meta: ReferenceMeta = {
    title: body.title?.trim() || undefined,
    wordCount: body.pastedText.length,
  };
  const topicLabel = body.title?.trim() || derivePasteLabel(body.pastedText);

  if (!body.sessionId) {
    const sessionId = nid();
    const title = (topicLabel?.trim() || "参考材料").slice(0, 60);
    try {
      const { session, node } = createSessionWithReference({
        sessionId,
        nodeId,
        title,
        sourceType: "paste",
        sourceUri: null,
        contentMd,
        meta,
        topicLabel,
        now,
      });
      return Response.json({ session, node });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  try {
    const node = createReferenceNode({
      nodeId,
      sessionId: body.sessionId,
      sourceType: "paste",
      sourceUri: null,
      contentMd,
      meta,
      topicLabel,
      now,
    });
    return Response.json({ node });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : 500;
    return Response.json({ error: msg }, { status });
  }
}

function handleUrlCreate(
  body: CreateUrlRequest,
  provider: ProviderId,
  signal: AbortSignal,
): Response {
  const now = Date.now();
  const nodeId = nid();
  const sourceUri = body.url;
  // Initial label is just the hostname; we'll overwrite it once the
  // claude fetcher returns a real title.
  const provisionalLabel = safeHostname(body.url);

  let placeholderSession: ApiSession | undefined;
  let placeholderNode: ApiNode;
  try {
    if (!body.sessionId) {
      const sessionId = nid();
      const title = (provisionalLabel || "参考材料").slice(0, 60);
      const created = createSessionWithReference({
        sessionId,
        nodeId,
        title,
        sourceType: "url",
        sourceUri,
        contentMd: "",
        meta: {},
        topicLabel: provisionalLabel,
        status: "streaming",
        now,
      });
      placeholderSession = created.session;
      placeholderNode = created.node;
    } else {
      placeholderNode = createReferenceNode({
        nodeId,
        sessionId: body.sessionId,
        sourceType: "url",
        sourceUri,
        contentMd: "",
        meta: {},
        topicLabel: provisionalLabel,
        status: "streaming",
        now,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Client gone — best-effort.
        }
      };

      send({
        type: "created",
        session: placeholderSession,
        node: placeholderNode,
      });

      let finalContentMd = "";
      let finalMeta: ReferenceMeta = {};
      let fetchErrorMsg: string | undefined;
      let gotResult = false;

      try {
        for await (const ev of fetchUrlEvents(body.url, provider, signal)) {
          if (ev.type === "progress") {
            send({ type: "progress", nodeId, message: ev.message });
          } else if (ev.type === "result") {
            gotResult = true;
            finalContentMd = ev.contentMd;
            finalMeta = ev.meta;
          } else if (ev.type === "error") {
            fetchErrorMsg = ev.message;
          }
        }
      } catch (err) {
        fetchErrorMsg =
          err instanceof Error ? err.message : String(err);
      }

      // Determine final status: error if no result OR explicit error;
      // done otherwise. Even when the result has fetch_error in
      // frontmatter, we mark the row "done" because claude *did* return
      // a structured response — the error info is carried in meta.
      const finalStatus: "done" | "error" =
        gotResult && !fetchErrorMsg ? "done" : "error";
      const errorForRow =
        finalStatus === "error"
          ? fetchErrorMsg ?? "fetcher 没有返回结果"
          : undefined;

      // If claude returned no usable content but we have a fetch error,
      // still write meta.fetchError so the UI can render it.
      const metaToPersist: ReferenceMeta = gotResult
        ? finalMeta
        : { fetchError: fetchErrorMsg ?? "fetcher 没有返回结果" };

      const updated = finalizeReferenceFetch({
        nodeId,
        contentMd: finalContentMd,
        meta: metaToPersist,
        status: finalStatus,
        topicLabel: metaToPersist.title?.trim() || provisionalLabel,
        errorMessage: errorForRow,
        now: Date.now(),
      });

      if (updated) {
        send({ type: "done", node: updated });
      } else {
        send({ type: "error", message: "节点丢失，无法落库" });
      }

      try {
        controller.close();
      } catch {
        /* already closed */
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

// 14-char fallback so participle-aware truncation doesn't matter — UI also
// truncates further with topicLabel display logic.
function derivePasteLabel(text: string): string {
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l);
  if (!firstLine) return "粘贴内容";
  return firstLine.length > 14 ? firstLine.slice(0, 14) : firstLine;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "外部链接";
  }
}

// Simple existence probe used by clients to verify a reference still
// resolves before performing a refresh — primarily for tests.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return Response.json({ error: "missing id" }, { status: 400 });
  }
  const node = getNode(id);
  if (!node) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ node });
}
