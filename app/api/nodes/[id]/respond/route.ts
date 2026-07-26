import { resolveInteraction } from "@/lib/server/run-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A路②: deliver a user's answer to a paused interactive tool (AskUserQuestion /
// ExitPlanMode). Body: { toolUseId, behavior: "allow" | "deny", updatedInput? }.
//
// The frontend constructs updatedInput — for AskUserQuestion that's the
// original input plus the chosen answers map (e.g. { ...input, answers: { ...
// } }); every other allow just echoes the original input back. behavior
// "allow" ALWAYS needs a record here — the SDK's schema rejects undefined
// (run-bus backfills as a last resort). The server doesn't parse updatedInput
// — it forwards the decision to the SDK callback, which resumes the model in
// place.
//
// 200 on resolve; 404 when there's no live run for this node; 409 when nothing
// is pending or a different toolUseId is awaiting (stale client).
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  let body: {
    toolUseId?: unknown;
    behavior?: unknown;
    updatedInput?: unknown;
    message?: unknown;
    // 权限确认:true + allow = 本轮内同名工具不再弹卡。
    alwaysAllowTool?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.toolUseId !== "string" || !body.toolUseId) {
    return Response.json({ error: "missing toolUseId" }, { status: 400 });
  }
  if (body.behavior !== "allow" && body.behavior !== "deny") {
    return Response.json(
      { error: "behavior must be 'allow' or 'deny'" },
      { status: 400 },
    );
  }

  const result = resolveInteraction(
    id,
    body.toolUseId,
    {
      behavior: body.behavior,
      updatedInput: body.updatedInput,
      message: typeof body.message === "string" ? body.message : undefined,
    },
    { alwaysAllowTool: body.alwaysAllowTool === true },
  );

  switch (result) {
    case "ok":
      return Response.json({ ok: true });
    case "no_run":
      return Response.json({ error: "no live run for node" }, { status: 404 });
    case "no_pending":
      return Response.json(
        { error: "no interaction pending" },
        { status: 409 },
      );
    case "mismatch":
      return Response.json(
        { error: "toolUseId does not match pending interaction" },
        { status: 409 },
      );
  }
}
