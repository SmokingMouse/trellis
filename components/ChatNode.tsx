"use client";
import { memo, useRef, useState, useEffect } from "react";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore } from "@/stores/sessionStore";
import { subscribeStream, getStreamPending } from "@/lib/stream-bus";
import { COMPACT_ZOOM_THRESHOLD } from "@/lib/layout";
import { MD_COMPONENTS } from "@/lib/md-components";
import { AttachmentPreview } from "./AttachmentPreview";
import { formatTokens } from "@/lib/format-tokens";
import { injectMarks, clearMarks, type MarkSpec } from "@/lib/dom-mark-injector";
import type { ChatNode as ChatNodeData } from "@/lib/types";
import { CollapseChip } from "./CollapseChip";
import { DeleteCardButton } from "./DeleteCardButton";
import { CopyButton } from "./CopyButton";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { SkillPickerList } from "./SkillPickerList";
import { ZoneEditor } from "./ZoneEditor";

// Plugin arrays at module scope so identity is stable across renders.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];

export type ChildAnchor = { text: string; childId: string };

export type ChatFlowNode = Node<
  {
    node: ChatNodeData;
    isActive: boolean;
    childAnchors: ChildAnchor[];
    // 1-based session-scoped index (createdAt order). 0 if unknown.
    index: number;
    // Total descendants (direct + indirect). Drives the "▶/▼ N" chip;
    // 0 means the node is a leaf and the chip is suppressed.
    descendantCount: number;
    // Whether this node's subtree is currently folded.
    collapsed: boolean;
  },
  "chat"
>;

function ChatNodeImpl({ data }: NodeProps<ChatFlowNode>) {
  const n = data.node;
  const isStreaming = n.status === "streaming";
  const isError = n.status === "error";
  const isActive = data.isActive;
  const indexLabel = data.index ? `#${data.index}` : "";
  // Only "done" nodes can be unread — streaming / error states have their
  // own visual treatment (indigo border / error states).
  const isUnread = n.status === "done" && !n.readAt;
  // ReactFlow viewport zoom: transform = [x, y, zoom]. Selector returns a
  // boolean so re-renders only fire when crossing the threshold.
  const isCompact = useStore((s) => s.transform[2] < COMPACT_ZOOM_THRESHOLD);

  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const retryNode = useSessionStore((s) => s.retryNode);
  const toggleCollapse = useSessionStore((s) => s.toggleCollapse);
  const showCollapseChip = data.descendantCount > 0;
  const onMarkClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("[data-child-id]");
    if (!target) return;
    const childId = target.getAttribute("data-child-id");
    if (!childId) return;
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    // ReactFlow's onNodeClick fires on the same click and would override
    // activeNodeId to the parent's id. Defer to win the race.
    window.setTimeout(() => setActiveNode(childId), 0);
  };
  // #7: reading happens in the linear thread anchored at this node (the old
  // fullscreen single-card reader is retired).
  const goRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveNode(n.id);
    setViewMode("linear");
  };
  // While streaming, deltas land on the stream-bus (not in React state).
  // We attach a textContent-only sink to a <pre> ref so each token is one
  // tiny DOM mutation, no React render, no ReactFlow diff. When the stream
  // finishes, sessionStore commits the full text and React re-renders this
  // node once with the full ReactMarkdown pipeline.
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isStreaming) return;
    const el = streamRef.current;
    if (!el) return;
    el.textContent = n.response + getStreamPending(n.id);
    return subscribeStream(n.id, (delta) => {
      el.textContent = (el.textContent ?? "") + delta;
    });
    // n.response intentionally excluded from deps: it doesn't change while
    // streaming (deltas bypass the store), and re-running this effect on
    // every render would clobber the DOM-direct text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, n.id]);

  // Inject child <mark> on the rendered markdown DOM. Same approach as
  // NodeFullView's ResponseBody — see lib/dom-mark-injector.ts.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isStreaming) return;
    const root = bodyRef.current;
    if (!root) return;
    clearMarks(root);
    if (data.childAnchors.length) {
      const specs: MarkSpec[] = [
        {
          dataKey: "childId",
          anchors: data.childAnchors.map((a) => ({
            text: a.text,
            id: a.childId,
          })),
        },
      ];
      injectMarks(root, specs);
    }
    return () => {
      if (root) clearMarks(root);
    };
  }, [isStreaming, n.response, data.childAnchors]);

  const labelText = n.topicLabel ?? truncate(n.question, 14);
  // Compact mode: streaming / error nodes always render full so user can see
  // progress and act. Done nodes at low zoom collapse to a topic card.
  const showCompact = isCompact && !isStreaming && !isError;

  if (showCompact) {
    return (
      <div
        className={`group relative nopan w-[280px] rounded-2xl bg-white dark:bg-stone-900 cursor-pointer transition-all duration-200 ring-1 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_6px_20px_-6px_rgba(28,25,23,0.10)] hover:shadow-[0_2px_4px_rgba(28,25,23,0.05),0_14px_30px_-8px_rgba(28,25,23,0.18)] hover:-translate-y-px ${
          isActive
            ? "ring-2 ring-indigo-400/80 dark:ring-indigo-500/70"
            : isUnread
              ? "ring-amber-300/80 dark:ring-amber-700/60"
              : "ring-stone-200/80 dark:ring-stone-800 hover:ring-stone-300 dark:hover:ring-stone-700"
        }`}
        onClick={goRead}
        title={n.question}
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
        <span
          className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full ${
            n.status !== "done"
              ? "bg-stone-300 dark:bg-stone-600"
              : isUnread
                ? "bg-amber-400"
                : "bg-emerald-400/70"
          }`}
          aria-hidden
          title={n.status === "done" ? (isUnread ? "未读" : "已读") : undefined}
        />
        <div className="px-4 py-3 flex items-center gap-2.5">
          {indexLabel && (
            <span className="shrink-0 text-[11px] font-mono text-stone-400 dark:text-stone-500 tabular-nums">
              {indexLabel}
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[18px] font-semibold text-stone-900 dark:text-stone-100 leading-tight truncate">
              {labelText}
            </div>
            {n.parentAnchor && (
              <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400 truncate">
                ↳ {truncate(n.parentAnchor.selectedText, 22)}
              </div>
            )}
          </div>
          {n.pendingInteraction && (
            <span
              className="shrink-0 px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 text-[10px] font-medium"
              title="待你回答"
            >
              🙋
            </span>
          )}
          <ToolCallBadge count={n.toolCalls.length} />
          <TokenMeta tokenCount={n.tokenCount} variant="compact" />
        </div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div
      className={`group relative nopan bg-white dark:bg-stone-900 border rounded-2xl shadow-sm w-[600px] transition-all ${
        isStreaming
          ? "border-indigo-300 dark:border-indigo-700 ring-4 ring-indigo-100 dark:ring-indigo-900/40"
          : isActive
            ? "border-indigo-400 dark:border-indigo-500 ring-2 ring-indigo-200/60 dark:ring-indigo-800/50 shadow-md"
            : isUnread
              ? "border-amber-300 dark:border-amber-700/70"
              : "border-stone-200 dark:border-stone-800"
      }`}
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
          variant="full"
        />
      )}

      {n.parentAnchor && (
        <div className="px-4 py-2 border-b border-stone-100 dark:border-stone-800 bg-amber-50 dark:bg-amber-950/40 text-[11px] text-amber-900 dark:text-amber-200 flex items-center gap-1.5 rounded-t-xl">
          <span className="text-amber-600 dark:text-amber-400">↳</span>
          <span>
            从「
            <span className="font-medium">
              {truncate(n.parentAnchor.selectedText, 40)}
            </span>
            」分叉
          </span>
        </div>
      )}

      {n.pendingInteraction && (
        <div
          className={`px-4 py-1.5 border-b border-amber-200 dark:border-amber-800/60 bg-amber-100/80 dark:bg-amber-900/40 text-[11px] font-medium text-amber-900 dark:text-amber-200 flex items-center gap-1.5 ${
            n.parentAnchor ? "" : "rounded-t-xl"
          }`}
        >
          <span>🙋</span>
          <span>待你回答</span>
        </div>
      )}

      <div
        className={`px-5 py-3 border-b border-stone-100 dark:border-stone-800 flex items-start gap-2.5 ${
          n.parentAnchor || n.pendingInteraction
            ? ""
            : "bg-indigo-50/60 dark:bg-indigo-950/30 rounded-t-xl"
        }`}
      >
        <div className="w-7 h-7 rounded-full bg-indigo-500 text-white text-[11px] flex items-center justify-center mt-0.5 shrink-0 font-medium">
          你
        </div>
        <div className="flex-1 text-[14.5px] text-stone-800 dark:text-stone-200 leading-relaxed pt-1 font-medium min-w-0">
          {indexLabel && (
            <span className="mr-1.5 font-mono text-[12px] text-stone-400 dark:text-stone-500 tabular-nums font-normal inline-flex items-center gap-1">
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
          {n.question}
          {n.attachments.length > 0 && (
            <div className="mt-2 font-normal">
              <AttachmentPreview attachments={n.attachments} readOnly />
            </div>
          )}
        </div>
        <button
          onClick={goRead}
          title="线性阅读"
          aria-label="线性阅读"
          className="shrink-0 mt-0.5 px-2 h-7 rounded-md bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-900 hover:text-white hover:border-stone-900 dark:hover:bg-stone-100 dark:hover:text-stone-900 dark:hover:border-stone-100 active:scale-95 flex items-center gap-1 text-[11px] font-medium transition-colors shadow-sm"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
          阅读
        </button>
      </div>

      <div
        ref={bodyRef}
        data-chat-node-id={n.id}
        onClick={onMarkClick}
        className="px-5 py-4 md-body text-[13.5px] text-stone-700 dark:text-stone-300 max-h-[420px] overflow-y-auto nodrag nowheel nopan"
      >
        {isStreaming ? (
          <>
            <div
              ref={streamRef}
              className="whitespace-pre-wrap break-words leading-relaxed"
            />
            <span className="streaming-cursor" />
          </>
        ) : n.response ? (
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_FULL}
            components={MD_COMPONENTS}
          >
            {n.response}
          </ReactMarkdown>
        ) : (
          <div className="text-stone-400 dark:text-stone-500 italic flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
            正在生成…
          </div>
        )}
        {isError &&
          (n.errorMessage === "aborted" ? (
            <div className="mt-3 p-2 bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700 rounded text-stone-600 dark:text-stone-300 text-xs flex items-start gap-2">
              <div className="flex-1">已停止生成</div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  retryNode(n.id);
                }}
                className="shrink-0 px-2 py-0.5 rounded bg-stone-700 dark:bg-stone-600 text-white text-[11px] hover:bg-stone-900 dark:hover:bg-stone-500 active:scale-95 transition-transform"
              >
                ↻ 重新发送
              </button>
            </div>
          ) : (
            <div className="mt-3 p-2 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-rose-700 dark:text-rose-300 text-xs flex items-start gap-2">
              <div className="flex-1">出错：{n.errorMessage}</div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  retryNode(n.id);
                }}
                className="shrink-0 px-2 py-0.5 rounded bg-rose-600 text-white text-[11px] hover:bg-rose-700 active:scale-95 transition-transform"
              >
                ↻ 重新生成
              </button>
            </div>
          ))}
      </div>

      <NodeFooter node={n} isStreaming={isStreaming} />

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

// React.memo with custom comparison so streaming a single node doesn't
// re-render every other node on every token. Hot path: handleStreamEvent
// in sessionStore preserves identity for non-streaming nodes (only the
// streaming node's object is replaced), so `prev.node === next.node`
// catches them. childAnchors is rebuilt by the Canvas selector on every
// nodeMap change but is small per-parent — value-compare it.
export const ChatNode = memo(ChatNodeImpl, (prev, next) => {
  if (prev.data.node !== next.data.node) return false;
  if (prev.data.isActive !== next.data.isActive) return false;
  if (prev.data.collapsed !== next.data.collapsed) return false;
  if (prev.data.descendantCount !== next.data.descendantCount) return false;
  const a = prev.data.childAnchors;
  const b = next.data.childAnchors;
  if (a !== b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].childId !== b[i].childId || a[i].text !== b[i].text) return false;
    }
  }
  return true;
});

function NodeFooter({
  node,
  isStreaming,
}: {
  node: ChatNodeData;
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const abortStream = useSessionStore((s) => s.abortStream);

  if (open) {
    return <FollowupInput node={node} onClose={() => setOpen(false)} />;
  }

  return (
    <div className="px-5 py-2 border-t border-stone-100 dark:border-stone-800 flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
      {isStreaming ? (
        <>
          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          <span>正在生成…</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              abortStream(node.id);
            }}
            className="ml-2 px-2 py-0.5 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-300 hover:bg-stone-900 hover:text-white hover:border-stone-900 dark:hover:bg-stone-100 dark:hover:text-stone-900 dark:hover:border-stone-100 active:scale-95 transition-colors flex items-center gap-1"
            title="停止生成 (Esc)"
            aria-label="停止生成"
          >
            <span className="inline-block w-2 h-2 bg-current rounded-[1px]" />
            停止
          </button>
        </>
      ) : (
        <>
          <ToolCallBadge count={node.toolCalls.length} />
          <TokenMeta tokenCount={node.tokenCount} variant="full" />
          {node.response && (
            <CopyButton
              text={node.response}
              className="nodrag ml-2 px-2 py-0.5 rounded text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
            />
          )}
          <button
            onClick={() => setOpen(true)}
            className="ml-1 px-2 py-0.5 rounded text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
          >
            + 追问
          </button>
        </>
      )}
      <span className="ml-auto text-stone-400 dark:text-stone-500 italic text-[11px]">
        或选中文字 → ⌘K 提问
      </span>
    </div>
  );
}

function FollowupInput({
  node,
  onClose,
}: {
  node: ChatNodeData;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const sendKey = useSessionStore((s) => s.sendKey);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const matchedSkills = useSkillSuggestions(
    q,
    sessionMode !== "chat" || chatEnhanced,
  );

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    const text = q.trim();
    if (!text) return;
    onClose();
    streamBranch(node.id, text, null);
  };

  return (
    <div className="relative border-t border-stone-100 dark:border-stone-800 bg-stone-50/60 dark:bg-stone-900/60">
      <SkillPickerList
        skills={matchedSkills}
        onPick={(name) => {
          setQ(`/${name} `);
          ref.current?.focus();
        }}
      />
      <textarea
        ref={ref}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (isSendCombo(e, sendKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={`对整段回复继续追问…（${sendHint(sendKey)}）`}
        rows={2}
        className="w-full px-5 py-3 outline-none resize-none text-sm bg-transparent text-stone-800 dark:text-stone-200 placeholder:text-stone-400 dark:placeholder:text-stone-500"
      />
      <div className="px-3 py-1.5 flex items-center justify-end gap-2 text-xs">
        <button
          onClick={() => setZoneOpen(true)}
          title="专注写作模式（全屏 Markdown 编辑 + 预览）"
          className="mr-auto px-2 py-0.5 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 inline-flex items-center gap-1"
        >
          <span aria-hidden>⛶</span>
          <span>专注写作</span>
        </button>
        <button
          onClick={onClose}
          className="px-2 py-0.5 text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={!q.trim()}
          className="px-2.5 py-0.5 rounded bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 disabled:opacity-40 hover:bg-stone-800 dark:hover:bg-stone-300"
        >
          提问
        </button>
      </div>
      {zoneOpen && (
        <ZoneEditor
          value={q}
          onChange={setQ}
          onSubmit={() => {
            if (!q.trim()) return;
            setZoneOpen(false);
            submit();
          }}
          onClose={() => setZoneOpen(false)}
          title="继续追问"
          placeholder="专注写下你的追问，支持 Markdown……"
          submitLabel="提问"
          submitDisabled={!q.trim()}
        />
      )}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Inline token meter shared by the compact-card right side and the
// Stage 17: small badge that surfaces tool-call count on the canvas
// card + fullscreen footer. Hidden when count is 0 so chat-mode nodes
// (which rarely invoke tools) don't grow extra clutter. Click is
// non-interactive — drill-down lives in ToolCallsPanel inside the
// fullscreen view.
function ToolCallBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="shrink-0 inline-flex items-center gap-0.5 text-[10px] tabular-nums text-stone-500 dark:text-stone-400"
      title={`本节点共调用 ${count} 个工具`}
    >
      🔧{count}
    </span>
  );
}

// fullscreen footer. Three buckets (↑ in, ↓ out, ⚡ cache hit). cache
// creation is collapsed into the cache slot only when non-zero (rare —
// happens on first cli-multi turn) by appending +N. We deliberately
// omit fields that are zero to keep idle nodes uncluttered.
function TokenMeta({
  tokenCount,
  variant,
}: {
  tokenCount: ChatNodeData["tokenCount"];
  variant: "compact" | "full";
}) {
  const { input, output, cacheRead, cacheCreation } = tokenCount;
  const hasAny =
    input > 0 || output > 0 || cacheRead > 0 || cacheCreation > 0;
  if (!hasAny) {
    return (
      <span
        className={
          variant === "compact"
            ? "shrink-0 text-[10px] text-stone-400 dark:text-stone-500 tabular-nums"
            : "text-stone-400 dark:text-stone-500 tabular-nums"
        }
      >
        —
      </span>
    );
  }
  const baseCls = "tabular-nums whitespace-nowrap";
  const sizeCls = variant === "compact" ? "text-[10px]" : "text-[11px]";
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1.5 ${sizeCls} ${baseCls} text-stone-500 dark:text-stone-400`}
      title={`输入 ${input} · 输出 ${output} · 缓存命中 ${cacheRead}${
        cacheCreation > 0 ? ` · 缓存写入 ${cacheCreation}` : ""
      }`}
    >
      <span>↑{formatTokens(input)}</span>
      <span>↓{formatTokens(output)}</span>
      {(cacheRead > 0 || cacheCreation > 0) && (
        <span className="text-emerald-600 dark:text-emerald-400">
          ⚡{formatTokens(cacheRead)}
          {cacheCreation > 0 ? `+${formatTokens(cacheCreation)}` : ""}
        </span>
      )}
    </span>
  );
}

