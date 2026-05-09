"use client";
import { memo, useState } from "react";
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useSessionStore } from "@/stores/sessionStore";
import type { ChatNode as ChatNodeData } from "@/lib/types";
import { refIcon, refSourceLabel } from "@/lib/ref-icon";
import { CollapseChip } from "./CollapseChip";
import { DeleteCardButton } from "./DeleteCardButton";

export type RefFlowNode = Node<
  {
    node: ChatNodeData;
    isActive: boolean;
    // 1-based session-scoped index (createdAt order). 0 if unknown.
    index: number;
    descendantCount: number;
    collapsed: boolean;
  },
  "reference"
>;

function ReferenceCardImpl({ data }: NodeProps<RefFlowNode>) {
  const n = data.node;
  const ref = n.reference;
  const isActive = data.isActive;
  const indexLabel = data.index ? `#${data.index}` : "";
  const isUnread = n.status === "done" && !n.readAt;
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setFullScreen = useSessionStore((s) => s.setFullScreen);
  const refreshReference = useSessionStore((s) => s.refreshReference);
  const abortStream = useSessionStore((s) => s.abortStream);
  const toggleCollapse = useSessionStore((s) => s.toggleCollapse);
  const showCollapseChip = data.descendantCount > 0;
  // Subscribe only to this node's progress slot — keeps re-renders to
  // when *our* progress changes.
  const fetchProgress = useSessionStore((s) => s.fetchProgress[n.id]);
  const [refreshing, setRefreshing] = useState(false);

  // Defensive: if a row claims kind="reference" but has no payload (data
  // corruption / mid-migration), fall back to a stub card rather than
  // crashing the canvas.
  if (!ref) {
    return (
      <div className="nopan bg-white dark:bg-stone-900 border border-rose-200 dark:border-rose-900 rounded-xl shadow-sm w-[280px] px-4 py-3 text-rose-700 dark:text-rose-300 text-xs">
        参考卡片数据缺失
        <Handle type="target" position={Position.Top} />
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  const isStreaming = n.status === "streaming";
  const labelText =
    n.topicLabel?.trim() ||
    (ref.sourceType === "paste" ? "粘贴内容" : refSourceLabel(ref));
  const sourceLine = refSourceLabel(ref);
  const wordCount = ref.meta.wordCount;
  const fetchError = ref.meta.fetchError;
  const canRefresh = ref.sourceType === "url" && !isStreaming;

  const goFullScreen = () => {
    setActiveNode(n.id);
    setFullScreen(true);
  };

  const onRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshReference(n.id);
    } catch {
      /* error already surfaces in the row's meta.fetchError */
    } finally {
      setRefreshing(false);
    }
  };

  const onCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    abortStream(n.id);
  };

  return (
    <div
      className={`group relative nopan bg-amber-50/40 dark:bg-amber-950/30 border rounded-xl shadow-sm w-[280px] cursor-pointer transition-shadow ${
        isActive
          ? "border-amber-400 dark:border-amber-600 ring-2 ring-amber-200 dark:ring-amber-900/50 shadow-md"
          : isStreaming
            ? "border-indigo-300 dark:border-indigo-700 ring-2 ring-indigo-100 dark:ring-indigo-900/40"
            : fetchError
              ? "border-rose-300 dark:border-rose-800"
              : "border-amber-300 dark:border-amber-800"
      }`}
      onClick={goFullScreen}
      title={ref.sourceUri ?? labelText}
    >
      <Handle type="target" position={Position.Top} />
      <DeleteCardButton nodeId={n.id} />
      {showCollapseChip && (
        <CollapseChip
          collapsed={data.collapsed}
          count={data.descendantCount}
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapse(n.id);
          }}
          variant="compact"
        />
      )}
      <div className="px-4 py-3 flex items-start gap-2.5">
        <span className="shrink-0 text-[18px] leading-none mt-0.5" aria-hidden>
          {isStreaming ? <Spinner /> : refIcon(ref)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-stone-900 dark:text-stone-100 leading-tight truncate">
            {indexLabel && (
              <span className="mr-1.5 font-mono text-[11px] text-stone-400 dark:text-stone-500 tabular-nums font-normal inline-flex items-center gap-1 align-middle">
                {indexLabel}
                {isUnread && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-amber-500"
                    aria-label="未读"
                    title="未读"
                  />
                )}
              </span>
            )}
            {labelText}
          </div>
          <div className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400 truncate">
            {sourceLine}
          </div>
          {isStreaming ? (
            <div className="mt-1 text-[11px] text-indigo-700 dark:text-indigo-300 truncate">
              {fetchProgress || "启动中…"}
            </div>
          ) : fetchError ? (
            <div className="mt-1 text-[11px] text-rose-600 dark:text-rose-400 truncate">
              ⚠️ {fetchError}
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-stone-400 dark:text-stone-500 tabular-nums">
              {wordCount ? `${wordCount} 字` : "—"}
              {ref.fetchedAt && ref.sourceType !== "paste" && (
                <span className="ml-1.5 opacity-70">
                  · {formatRelativeTime(ref.fetchedAt)}
                </span>
              )}
            </div>
          )}
        </div>
        {isStreaming ? (
          <button
            onClick={onCancel}
            className="shrink-0 -mr-1 -mt-1 px-1.5 py-1 rounded text-stone-500 dark:text-stone-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-700 dark:hover:text-rose-300 active:scale-95 transition-colors"
            title="停止抓取"
            aria-label="停止抓取"
          >
            <span className="inline-block w-2.5 h-2.5 bg-current rounded-[2px]" />
          </button>
        ) : (
          canRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="shrink-0 -mr-1 -mt-1 px-1.5 py-1 rounded text-stone-500 dark:text-stone-400 hover:bg-amber-100 dark:hover:bg-amber-950/60 hover:text-stone-800 dark:hover:text-stone-200 active:scale-95 disabled:opacity-40 transition-colors"
              title="重新抓取"
              aria-label="重新抓取"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={refreshing ? "animate-spin" : ""}
              >
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
            </button>
          )
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      className="text-indigo-500 animate-spin"
      aria-hidden
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  );
}

// Reference card identity is stable while the node row reference is stable.
// Selection / refresh / canvas pan all preserve identity for non-streaming
// nodes (sessionStore.handleStreamEvent only touches streaming nodes).
// Progress messages bypass the `node` ref via a separate Zustand selector,
// so streaming-state re-renders only fire when this card's progress text
// changes — not when other refs in the session also stream.
export const ReferenceCard = memo(ReferenceCardImpl);

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}
