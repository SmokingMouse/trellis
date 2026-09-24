import { decideMember } from "@/lib/server/lark/access";
import {
  deleteLarkBotMember,
  deleteLarkBotMemberById,
  getLarkBot,
  getLarkBotMember,
  getLarkBotMemberById,
  listLarkBotMembers,
  preapproveMember,
  updateMemberRole,
} from "@/lib/server/lark/store";
import type { LarkBotMemberRole, LarkBotMemberStatus } from "@/lib/lark-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Context) {
  const { id: botId } = await ctx.params;
  const bot = getLarkBot(botId);
  if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });
  return Response.json({ members: listLarkBotMembers(botId) });
}

export async function POST(req: Request, ctx: Context) {
  const { id: botId } = await ctx.params;
  const bot = getLarkBot(botId);
  if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const obj = (body ?? {}) as {
    openId?: string;
    role?: LarkBotMemberRole;
    name?: string;
    status?: LarkBotMemberStatus;
  };

  const openId = obj.openId?.trim();
  if (!openId) {
    return Response.json({ error: "openId 不能为空" }, { status: 400 });
  }

  const role: LarkBotMemberRole = obj.role === "admin" ? "admin" : "member";
  const member = preapproveMember({
    botId,
    openId,
    role,
    name: obj.name?.trim() || null,
  });

  return Response.json({ member }, { status: 201 });
}

export async function PATCH(req: Request, ctx: Context) {
  const { id: botId } = await ctx.params;
  const bot = getLarkBot(botId);
  if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const obj = (body ?? {}) as {
    id?: string;
    openId?: string;
    code?: string;
    status?: LarkBotMemberStatus;
    role?: LarkBotMemberRole;
  };

  if (!obj.id && !obj.openId && !obj.code) {
    return Response.json({ error: "必须指定 id, openId 或 code" }, { status: 400 });
  }

  // 1. 如果有 status 变更（审批决定）
  if (obj.status === "approved" || obj.status === "denied") {
    const res = await decideMember({
      botId,
      openIdOrCode: { id: obj.id, openId: obj.openId, code: obj.code },
      decision: obj.status,
      decidedBy: "admin",
    });

    if (!res.ok) {
      return Response.json({ error: res.message }, { status: 400 });
    }

    if (obj.role && res.member) {
      updateMemberRole(botId, res.member.openId, obj.role);
    }

    const updated = getLarkBotMember(botId, res.member!.openId);
    return Response.json({ member: updated, message: res.message });
  }

  // 2. 如果只改 role
  if (obj.role) {
    let targetOpenId = obj.openId;
    if (!targetOpenId && obj.id) {
      targetOpenId = getLarkBotMemberById(obj.id)?.openId;
    }
    if (!targetOpenId) {
      return Response.json({ error: "未找到目标成员" }, { status: 404 });
    }
    const updated = updateMemberRole(botId, targetOpenId, obj.role);
    return Response.json({ member: updated });
  }

  return Response.json({ error: "未提供有效的 status 或 role 变更" }, { status: 400 });
}

export async function DELETE(req: Request, ctx: Context) {
  const { id: botId } = await ctx.params;
  const bot = getLarkBot(botId);
  if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });

  const url = new URL(req.url);
  const openId = url.searchParams.get("openId");
  const memberId = url.searchParams.get("id");

  let deleted = false;
  if (openId) {
    deleted = deleteLarkBotMember(botId, openId);
  } else if (memberId) {
    deleted = deleteLarkBotMemberById(memberId);
  } else {
    try {
      const body = (await req.json()) as { openId?: string; id?: string };
      if (body.openId) deleted = deleteLarkBotMember(botId, body.openId);
      else if (body.id) deleted = deleteLarkBotMemberById(body.id);
    } catch {
      // ignore
    }
  }

  return deleted
    ? Response.json({ ok: true })
    : Response.json({ error: "未找到成员或删除失败" }, { status: 404 });
}
