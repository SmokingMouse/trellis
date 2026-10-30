"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { useGroupStore } from "@/stores/groupStore";
import type { Group } from "@/lib/groups";

/** 当前会话是群聊（sessions.kind='group'）时返回群；列表还没拉到或不是群 = null。
 * 顶栏 / 时间线 / 输入框都靠它分支，null 时一律走原来的渲染。 */
export function useCurrentGroup(): Group | null {
  const groupId = useSessionStore((s) => (s.session?.kind === "group" ? s.session.id : null));
  return useGroupStore((s) => (groupId ? (s.groups.find((g) => g.id === groupId) ?? null) : null));
}

/** 只看会话行判断「是不是群」（群列表还没到时也成立）。 */
export function useIsGroupSession(): boolean {
  return useSessionStore((s) => s.session?.kind === "group");
}
