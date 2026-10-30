"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { useRoleStore } from "@/stores/roleStore";
import type { Role } from "@/lib/roles";

// 当前视图属于哪个角色：会话的 agentId 命中角色列表（角色会话 kind='role'，agent_id = 角色），
// 或还没会话、停在角色草稿（roleDraft）。顶栏 / 时间线 / 输入框 / 一览都靠它分支，
// 返回 null 时一律走原来的普通会话渲染。
// 角色列表还没拉到时返回 null（侧栏挂载就会 refresh，拉到后自然切过来）。
export function useCurrentRole(): Role | null {
  const roleId = useSessionStore((s) => (s.session ? (s.session.agentId ?? null) : s.homeOpen ? s.roleDraft : null));
  return useRoleStore((s) => (roleId ? (s.roles.find((r) => r.id === roleId) ?? null) : null));
}
