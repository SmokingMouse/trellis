import "server-only";
import { getDB } from "./sqlite";
import type { RoleBadge, SessionRoleTag } from "@/lib/role-follow";

// 搜索 / @ 候选结果上的角色标记：会话 kind='role' 且 agent_id 指向一个角色 → 带头像与名字。
// 一次查完全部角色（角色是个位数到几十个），调用方按 agent_id 查表。

export function roleBadgeMap(): Map<string, RoleBadge> {
  const rows = getDB()
    .prepare("SELECT id, name, avatar_hue, avatar_glyph FROM agents WHERE kind = 'role'")
    .all() as { id: string; name: string; avatar_hue: number; avatar_glyph: string }[];
  return new Map(
    rows.map((r) => [r.id, { id: r.id, name: r.name, avatarHue: r.avatar_hue, avatarGlyph: r.avatar_glyph }]),
  );
}

export function sessionRoleTag(
  kind: string | null | undefined,
  agentId: string | null | undefined,
  badges: Map<string, RoleBadge>,
): SessionRoleTag {
  const sessionKind = kind ?? "user";
  return { sessionKind, role: sessionKind === "role" && agentId ? (badges.get(agentId) ?? null) : null };
}
