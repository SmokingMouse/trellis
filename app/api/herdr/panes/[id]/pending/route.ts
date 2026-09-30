import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/herdr/panes/:id/pending —— transcript 待答卡发键前的核对：
// 窗格此刻的 herdr 状态 + 其 jsonl 里仍未完成的 tool_use（按 size+mtime 缓存，文件动了就重读）。
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const service = getHerdrFleetService();
  await service.ensureStarted();
  const { status, prompt } = service.paneTranscriptPrompt(id);
  return Response.json(
    { status, toolUseId: prompt?.toolUseId ?? null, toolName: prompt?.toolName ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
