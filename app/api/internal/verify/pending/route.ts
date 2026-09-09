import { getNode } from "@/lib/server/repo";
import { startRun, hasLiveRun } from "@/lib/server/run-bus";

export const runtime = "nodejs";
export async function POST(req: Request) {
  // Explicit verification build + isolated process opt-in; never a live model.
  if (process.env.NEXT_PUBLIC_TRELLIS_VERIFY !== "1" || process.env.TRELLIS_VERIFY_PENDING !== "1") {
    return new Response(null, { status: 404 });
  }
  const { nodeId } = await req.json();
  if (typeof nodeId !== "string" || !nodeId.startsWith("mv-followup-")) return new Response(null, { status: 400 });
  const node = getNode(nodeId);
  const interaction = node?.pendingInteraction;
  if (!interaction || hasLiveRun(nodeId)) return new Response(null, { status: 409 });
  startRun({ nodeId, resumeFamily: "mock", interactive: true, requireApproval: true,
    factory: async function* (_signal, context) {
      const result = await context.onCanUseTool!({ ...interaction, requestId: interaction.toolUseId });
      yield { type: "delta", text: result.behavior === "allow" ? "验证：已允许一次。" : "验证：已拒绝。" };
      yield { type: "done" };
    } });
  return Response.json({ ok: true });
}
