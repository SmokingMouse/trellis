"use client";
import { WorkspaceDiffModal } from "@/components/WorkspaceDiffModal";
import { useDiffReviewStore } from "@/stores/diffReviewStore";
import { useSessionStore } from "@/stores/sessionStore";

// 会话内入口（顶栏菜单 / 手机溢出菜单 / 「本轮生成」文件条）打开的 diff 审阅。
// 切会话时自动收起：审阅目标与当前会话不一致就不渲染。
export function DiffReviewHost() {
  const target = useDiffReviewStore((s) => s.target);
  const closeReview = useDiffReviewStore((s) => s.closeReview);
  const session = useSessionStore((s) => s.session);
  if (!target || session?.id !== target.sessionId) return null;
  return (
    <WorkspaceDiffModal
      key={`${target.sessionId}:${target.scope ?? "all"}:${target.turnNodeId ?? ""}`}
      sessionId={target.sessionId}
      workspacePath={session.workspacePath ?? undefined}
      initialScope={target.scope}
      turnNodeId={target.turnNodeId}
      onClose={closeReview}
    />
  );
}
