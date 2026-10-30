import {
  HerdrApiError,
  isHerdrSendRefused,
  HerdrUnavailableError,
} from "@/lib/server/herdr-client";
import { getHerdrFleetService } from "@/lib/server/herdr-fleet";
import { isClientMsgId } from "@/lib/server/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  // clientMsgId：客户端给这条消息的 id（Outbox 重发沿用），TTL 内重复请求回第一次的结果、不重复打字。
  let body: { text?: unknown; clearDraft?: unknown; clientMsgId?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return Response.json({ error: "expected non-empty { text }" }, { status: 400 });
  }
  if (Buffer.byteLength(body.text, "utf8") > 32 * 1024) {
    return Response.json({ error: "text exceeds 32 KiB" }, { status: 413 });
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) {
    return Response.json({ error: "text contains terminal control characters" }, { status: 400 });
  }
  // 用户看过「电脑上有草稿」的拒发提示后选了「清空并发送」：带回服务端给的那段 clearable。
  if (body.clearDraft !== undefined && (typeof body.clearDraft !== "string" || !body.clearDraft || Buffer.byteLength(body.clearDraft, "utf8") > 8 * 1024)) {
    return Response.json({ error: "clearDraft must be a non-empty string" }, { status: 400 });
  }
  if (body.clientMsgId !== undefined && !isClientMsgId(body.clientMsgId)) {
    return Response.json({ error: "invalid clientMsgId" }, { status: 400 });
  }
  const { id } = await context.params;
  try {
    const service = getHerdrFleetService();
    await service.ensureStarted();
    const result = await service.input(id, body.text, body.clearDraft as string | undefined, body.clientMsgId as string | undefined);
    return Response.json({ ok: true, status: result.status, result }, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    // 发前读屏拒发：什么都没打（delivered: none），带上原因和电脑端草稿，前端据此提示 / 清空重发。
    if (isHerdrSendRefused(error)) {
      return Response.json(
        { error: error.message, delivered: "none", ...error.refusal },
        { status: 409 },
      );
    }
    const status =
      error instanceof HerdrUnavailableError
        ? 503
        : error instanceof HerdrApiError && error.code === "queue_full"
          ? 429
        : error instanceof HerdrApiError && error.code === "not_agent_pane"
          ? 403
        : error instanceof HerdrApiError && error.code === "pane_not_found"
          ? 404
          : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}

// 撤回一条排队中的输入（HerdrComposer 排队列表的「撤回」）。已送达 / 已失败的返回 409。
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const inputId = new URL(req.url).searchParams.get("inputId");
  if (!inputId || inputId.length > 64) {
    return Response.json({ error: "expected ?inputId=" }, { status: 400 });
  }
  const { id } = await context.params;
  const service = getHerdrFleetService();
  await service.ensureStarted();
  const cancelled = service.cancelInput(id, inputId);
  return cancelled
    ? Response.json({ ok: true })
    : Response.json({ error: "input is no longer queued" }, { status: 409 });
}
