import {
  HerdrApiError,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/herdr/panes/:id/focus —— 在 Herdr 终端里把焦点切到该窗格（操作台的次要菜单项）。
// 只读降级（协议不符）时 HerdrClient.request 拒绝写方法 → 503，前端据 fleet.readOnly 禁用入口。
export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    await service.focus(id);
    return Response.json({ ok: true });
  } catch (error) {
    const status =
      error instanceof HerdrUnavailableError
        ? 503
        : error instanceof HerdrApiError && error.code === "pane_not_found"
          ? 404
          : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
