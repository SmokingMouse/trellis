import {
  createNote,
  listNotesBySession,
  type ApiNote,
} from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/notes?sessionId=<id> — list this session's notebook entries.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "missing sessionId" }, { status: 400 });
  }
  const notes: ApiNote[] = listNotesBySession(sessionId);
  return Response.json({ notes });
}

type CreateRequest = {
  sessionId: string;
  sourceNodeId: string;
  quotedText: string;
};

function isCreate(b: unknown): b is CreateRequest {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.sessionId === "string" &&
    o.sessionId.length > 0 &&
    typeof o.sourceNodeId === "string" &&
    o.sourceNodeId.length > 0 &&
    typeof o.quotedText === "string" &&
    o.quotedText.length > 0
  );
}

function nid(): string {
  return crypto.randomUUID();
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!isCreate(body)) {
    return Response.json(
      {
        error:
          "expected { sessionId, sourceNodeId, quotedText: string }",
      },
      { status: 400 },
    );
  }
  try {
    const note = createNote({
      noteId: nid(),
      sessionId: body.sessionId,
      sourceNodeId: body.sourceNodeId,
      quotedText: body.quotedText,
      now: Date.now(),
    });
    return Response.json({ note });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("not found") ? 404 : 500;
    return Response.json({ error: msg }, { status });
  }
}
