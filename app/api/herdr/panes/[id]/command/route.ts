import {
  HerdrApiError,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 向任意窗格（包括纯 shell 窗格）执行命令或按键（终端抽屉与控制台使用）。
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let body: { command?: unknown; keys?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const command = typeof body.command === "string" ? body.command : "";
  const keys = Array.isArray(body.keys)
    ? (body.keys as string[])
    : command
      ? ["Enter"]
      : [];

  if (!command && keys.length === 0) {
    return Response.json(
      { error: "expected non-empty command or keys" },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.command(id, command, keys);
    return Response.json({ ok: true, result });
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
