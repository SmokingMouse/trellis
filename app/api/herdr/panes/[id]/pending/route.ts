import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/herdr/panes/:id/pending —— 发键前的核对：
//   - 窗格此刻的 herdr 状态 + 其 jsonl 里仍未完成的 tool_use（按 size+mtime 缓存，文件动了就重读）；
//   - 现读屏幕认出的对话框（prompt）和它的 rev：作答时把 rev 作为 expectedRev 带给 /keys、/text，
//     屏幕上的对话框变了就 409 prompt_changed。读屏失败时 prompt=null、rev=""，不影响前两项。
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const service = getHerdrFleetService();
  await service.ensureStarted();
  const { status, prompt } = service.paneTranscriptPrompt(id);
  const screen = await service.readPrompt(id).catch(() => ({ prompt: null, rev: "" }));
  return Response.json(
    {
      status,
      toolUseId: prompt?.toolUseId ?? null,
      toolName: prompt?.toolName ?? null,
      screen: screen.prompt,
      rev: screen.rev,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
