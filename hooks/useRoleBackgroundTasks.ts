"use client";
import { useEffect, useMemo } from "react";
import { useRoleExtrasStore } from "@/stores/roleExtrasStore";
import type { ChatNode } from "@/lib/types";

// 角色时间线 / 一览用的后台任务列表保鲜：进角色会话拉一次；会话里有轮次结束（角色可能刚开了
// 后台任务）再拉；列表里有还在跑的就每 15s 轮询一次，跑完自动停。
const POLL_MS = 15_000;

export function useRoleBackgroundTasks(roleId: string | null, nodes: Record<string, ChatNode>): void {
  const load = useRoleExtrasStore((s) => s.loadBgTasks);
  const running = useRoleExtrasStore((s) =>
    roleId ? (s.bgTasks[roleId] ?? []).some((t) => t.status === "streaming") : false,
  );
  // 已完成的轮数：变了就重拉（新的一轮结束 = 可能新开了后台任务）。
  const doneCount = useMemo(
    () => Object.values(nodes).filter((n) => n.status !== "streaming").length,
    [nodes],
  );
  useEffect(() => {
    if (roleId) void load(roleId);
  }, [roleId, doneCount, load]);
  useEffect(() => {
    if (!roleId || !running) return;
    const t = setInterval(() => void load(roleId), POLL_MS);
    return () => clearInterval(t);
  }, [roleId, running, load]);
}
