import { handoffInteraction, resolveInteraction } from "@/lib/server/agent-hooks/interactions";
import { notifyConsoleChange } from "@/lib/server/console-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/herdr/interactions/:id —— 阻塞交互的结构化作答（HerdrInteractionCard）。
 * 鉴权同其余 /api/herdr/*：proxy.ts 的 cookie 闸。
 *
 *   { action: "answer", answer: { type: "answers", answers: { 问题原文: label } } }
 *   { action: "answer", answer: { type: "permission", allow: true, always?: true } | { type: "permission", allow: false, message? } }
 *   { action: "answer", answer: { type: "plan", approve: true, mode: "bypassPermissions" | "acceptEdits" } | { type: "plan", approve: false, feedback? } }
 *   { action: "handoff" }   交给终端：hook 无输出退出，TUI 照常弹框
 *
 * 409 = 已经了结 / hook 断开超过 3 分钟（卡片据此退回读屏 / 发键路径）。
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  let body: { action?: unknown; answer?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { id } = await context.params;
  if (!/^ix_[0-9a-f]{8,64}$/.test(id)) {
    return Response.json({ error: "bad interaction id" }, { status: 400 });
  }
  const result =
    body.action === "handoff"
      ? handoffInteraction(id)
      : body.action === "answer"
        ? resolveInteraction(id, body.answer)
        : null;
  if (!result) return Response.json({ error: "expected action answer | handoff" }, { status: 400 });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  notifyConsoleChange("hook");
  return Response.json({ ok: true, connected: result.connected });
}
