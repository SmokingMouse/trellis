"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";

// Tiny ✕ chip parked at the top-right corner of any canvas card,
// hover-only so it doesn't add visual noise. Hidden on the session's
// qa root (those need the "delete session" path instead).
export function DeleteCardButton({ nodeId }: { nodeId: string }) {
  const sessionRootId = useSessionStore((s) => s.session?.rootNodeId);
  const confirmDelete = useConfirmDelete();
  if (sessionRootId === nodeId) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        confirmDelete(nodeId);
      }}
      title="删除节点（含子树）"
      aria-label="删除节点"
      className="absolute -top-2 -right-2 z-10 w-5 h-5 rounded-full border bg-white dark:bg-stone-900 border-stone-300 dark:border-stone-700 text-stone-500 dark:text-stone-400 shadow-sm opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-rose-50 dark:hover:bg-rose-950/50 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-300 dark:hover:border-rose-800 transition-opacity flex items-center justify-center"
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M3 3 L9 9 M9 3 L3 9" />
      </svg>
    </button>
  );
}
