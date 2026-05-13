import { abortRun } from "@/lib/server/run-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stage 17: explicit abort. Replaces the old "client AbortController →
// req.signal" path now that HTTP disconnect is no longer fatal to the
// run. UI's ⏹ button and the Esc handler both POST here. Returns 200
// for successful abort, 404 if there's no live run (already finished or
// never existed) — the client treats both as "stream is done" and
// reconciles via the next GET /api/nodes/[id]/stream if needed.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = abortRun(id);
  return Response.json({ aborted: ok }, { status: ok ? 200 : 404 });
}
