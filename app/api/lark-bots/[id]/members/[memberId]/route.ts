import { decideMember } from "@/lib/server/lark/access";
import {
  deleteLarkBotMember,
  deleteLarkBotMemberById,
  getLarkBot,
  getLarkBotMember,
  getLarkBotMemberById,
  updateMemberRole,
} from "@/lib/server/lark/store";
import type { LarkBotMemberRole, LarkBotMemberStatus } from "@/lib/lark-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; memberId: string }> };

export async function PATCH(req: Request, ctx: Context) {
  const { id: botId, memberId } = await ctx.params;
  const bot = getLarkBot(botId);
  if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const obj = (body ?? {}) as {
    status?: LarkBotMemberStatus;
    role?: LarkBotMemberRole;
  };

  const member = getLarkBotMemberById(memberId) || getLarkBotMember(botId, memberId);
  if (!member) {
    return Response.json({ error: "member not found" }, { status: 404 });
  }

  if (obj.status === "approved" || obj.status === "denied") {
    const res = await decideMember({
      botId,
      openIdOrCode: { id: member.id },
      decision: obj.status,
      decidedBy: "admin",
    });

    if (!res.ok) {
      return Response.json({ error: res.message }, { status: 400 });
    }

    if (obj.role) {
      updateMemberRole(botId, member.openId, obj.role);
    }

    const updated = getLarkBotMember(botId, member.openId);
    return Response.json({ member: updated, message: res.message });
  }

  if (obj.role) {
    const updated = updateMemberRole(botId, member.openId, obj.role);
    return Response.json({ member: updated });
  }

  return Response.json({ error: "未提供有效变更" }, { status: 400 });
}

export async function DELETE(_req: Request, ctx: Context) {
  const { id: botId, memberId } = await ctx.params;
  const bot = getLarkBot(botId);
  if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });

  const deleted = deleteLarkBotMemberById(memberId) || deleteLarkBotMember(botId, memberId);
  return deleted
    ? Response.json({ ok: true })
    : Response.json({ error: "not found" }, { status: 404 });
}
