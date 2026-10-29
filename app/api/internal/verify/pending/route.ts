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
      const startedAt = Date.now();
      yield { type: "tool_call_start", id: interaction.toolUseId, name: interaction.toolName, input: interaction.input, startedAt };
      const result = await context.onCanUseTool!({ ...interaction, requestId: interaction.toolUseId });
      yield { type: "tool_call_done", id: interaction.toolUseId, output: result.behavior, stderr: null, isError: result.behavior !== "allow", endedAt: Date.now() };
      yield { type: "delta", text: result.behavior === "allow" ? "验证：已允许一次。" : "验证：已拒绝。" };
      // 审批三档作用域验收：-scope 节点再发一次同工具调用。选了本会话 / 所有会话
      // 的话应当不弹卡、调用行尾挂「按规则允许」；仅本次则会再弹一张卡。
      if (nodeId.includes("-scope") && result.behavior === "allow") {
        const again = `${interaction.toolUseId}-again`;
        yield { type: "tool_call_start", id: again, name: interaction.toolName, input: interaction.input, startedAt: Date.now() };
        const second = await context.onCanUseTool!({ ...interaction, toolUseId: again, requestId: again });
        yield { type: "tool_call_done", id: again, output: second.behavior, stderr: null, isError: second.behavior !== "allow", endedAt: Date.now() };
        yield { type: "delta", text: `\n\n第二次同工具调用：${second.behavior === "allow" ? "已放行" : "已拒绝"}。` };
      }
      yield { type: "done" };
    } });
  return Response.json({ ok: true });
}
