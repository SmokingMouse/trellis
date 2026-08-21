"use client";
import { memo, useRef, useState, useEffect } from "react";
import {
  Handle,
  Position,
  useStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useSessionStore } from "@/stores/sessionStore";
import {
  subscribeStream,
  getStreamPending,
  thinkingChannel,
} from "@/lib/stream-bus";
import { isAuthErrorMessage } from "@/lib/auth-error";
import { COMPACT_ZOOM_THRESHOLD, PEEK_CARD_HEIGHT } from "@/lib/layout";
import { MarkdownBody } from "@/lib/markdown-cache";
import { AttachmentPreview } from "./AttachmentPreview";
import { formatTokens } from "@/lib/format-tokens";
import { TurnStatsMeta } from "./TurnStatsMeta";
import { injectMarks, clearMarks, type MarkSpec } from "@/lib/dom-mark-injector";
import type { ChatNode as ChatNodeData, ToolCall } from "@/lib/types";
import {
  buildToolTree,
  countToolTree,
  subagentLabel,
  walkToolTree,
} from "@/lib/tool-tree";
import { CollapseChip } from "./CollapseChip";
import { DeleteCardButton } from "./DeleteCardButton";
import { SupersededErrorNotice } from "./SupersededErrorNotice";
import { CopyButton } from "./CopyButton";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { useSlashNav } from "@/hooks/useSlashNav";
import { SkillPickerList } from "./SkillPickerList";
import { ZoneEditor } from "./ZoneEditor";
import { EmptyResponseNotice } from "./EmptyResponseNotice";
import { providerFamily } from "@/lib/llm";

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
    // Peek: render this node's full card in place on the canvas (instead of
    // the compact topic card) without switching to the linear reader.
    isPeeked: boolean;
    onTogglePeek: (id: string) => void;
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

  // Extended thinking indicator: claude thinks BEFORE it answers (minutes
  // under high effort), during which streamRef stays empty and the card used
  // to look dead. DOM-direct toggle (same no-React-render discipline as
  // streamRef): visible while thinking deltas flow and no text has arrived.
  const thinkingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isStreaming) return;
    const el = thinkingRef.current;
    if (!el) return;
    const sync = () => {
      const hasText =
        n.response.length > 0 || getStreamPending(n.id).length > 0;
      const hasThinking = getStreamPending(thinkingChannel(n.id)).length > 0;
      el.style.display = hasThinking && !hasText ? "flex" : "none";
    };
    sync();
    const unsubThinking = subscribeStream(thinkingChannel(n.id), sync);
    const unsubText = subscribeStream(n.id, sync);
    return () => {
      unsubThinking();
      unsubText();
    };
    // n.response excluded for the same reason as the effect above.
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
  // 错误降级：有后代 = 用户已在后续节点续跑/绕过，错误不再是"待处理"状态。
  const errorSuperseded = isError && data.descendantCount > 0;
  // Compact mode: streaming / fresh-error nodes always render full so user
  // can see progress and act. Done nodes — and superseded errors, whose
  // loud treatment has expired — collapse to a topic card at low zoom.
  const showCompact =
    isCompact &&
    !isStreaming &&
    (!isError || errorSuperseded) &&
    !data.isPeeked;

  if (showCompact) {
    return (
      <div
        className={`group relative nopan w-[280px] rounded-card bg-surface cursor-pointer transition-all duration-200 ring-1 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_6px_20px_-6px_rgba(28,25,23,0.10)] hover:shadow-[0_2px_4px_rgba(28,25,23,0.05),0_14px_30px_-8px_rgba(28,25,23,0.18)] hover:-translate-y-px ${
          isActive
            ? "ring-2 ring-accent/80"
            : isUnread
              ? "ring-unread-line/80"
              : "ring-line/80 hover:ring-line-strong"
        }`}
        onClick={goRead}
        title={n.question}
      >
        <Handle type="target" position={Position.Top} />
        <DeleteCardButton nodeId={n.id} />
        {/* Peek toggle: a hover-only corner chip matching DeleteCardButton's
            circle, parked just left of the ✕ — same visual language, no
            content-row clutter. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onTogglePeek(n.id);
          }}
          title="展开预览（留在画布）"
          aria-label="展开预览"
          className="absolute -top-2 right-4 z-10 w-5 h-5 rounded-full border bg-surface border-line-strong text-ink-muted shadow-raise opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-ink hover:text-ink-inverse hover:border-ink transition-opacity flex items-center justify-center"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
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
            isError
              ? "bg-warn"
              : n.status !== "done"
                ? "bg-line-strong"
                : isUnread
                  ? "bg-unread"
                  : "bg-line-strong/70"
          }`}
          aria-hidden
          title={n.status === "done" ? (isUnread ? "未读" : "已读") : undefined}
        />
        <div className="px-4 py-3 flex items-center gap-2.5">
          {indexLabel && (
            <span className="shrink-0 text-label font-mono text-ink-faint tabular-nums">
              {indexLabel}
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-title font-semibold text-ink-strong leading-tight truncate">
              {labelText}
            </div>
            {n.parentAnchor && (
              <div className="mt-0.5 text-label text-fork-ink truncate">
                ↳ {truncate(n.parentAnchor.selectedText, 22)}
              </div>
            )}
          </div>
          {n.pendingInteraction && (
            <span
              className="shrink-0 px-1.5 py-0.5 rounded-full bg-warn-muted text-warn-ink text-nano font-medium"
              title="待你回答"
            >
              🙋
            </span>
          )}
          {isError && (
            <span
              className="shrink-0 text-warn-ink text-nano"
              title={
                n.errorMessage === "aborted"
                  ? "本轮已手动停止（后续已继续）"
                  : `本轮中途中断（后续已继续）：${n.errorMessage ?? ""}`
              }
            >
              ⚠
            </span>
          )}
          <ToolCallBadge toolCalls={n.toolCalls} stats={n.toolCallStats} />
          <TurnStatsMeta
            tokenCount={n.tokenCount}
            durationMs={n.durationMs}
            createdAt={n.createdAt}
            toolCalls={n.toolCalls}
            isStreaming={false}
            variant="compact"
          />
        </div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }

  return (
    <div
      // When shown because of peek, pin to a fixed height and let the body
      // flex-fill + scroll inside — so the card's on-canvas footprint is a
      // known constant the layout can reserve exactly (see PEEK_CARD_HEIGHT).
      style={data.isPeeked ? { height: PEEK_CARD_HEIGHT } : undefined}
      className={`group relative nopan bg-surface border rounded-card shadow-raise w-[600px] transition-all ${
        data.isPeeked ? "flex flex-col" : ""
      } ${
        isStreaming
          ? "border-accent-line ring-4 ring-accent-muted"
          : isActive
            ? "border-accent ring-2 ring-accent-line/60 shadow-raise"
            : isUnread
              ? "border-unread-line"
              : "border-line"
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
        <div className="px-4 py-2 border-b border-line-faint bg-fork-muted text-label text-fork-ink flex items-center gap-1.5 rounded-t-card">
          <span className="text-fork">↳</span>
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
          className={`px-4 py-1.5 border-b border-warn-line bg-warn-muted text-label font-medium text-warn-ink flex items-center gap-1.5 ${
            n.parentAnchor ? "" : "rounded-t-card"
          }`}
        >
          <span>🙋</span>
          <span>待你回答</span>
        </div>
      )}

      <div
        className={`px-5 py-3 border-b border-line-faint flex items-start gap-2.5 ${
          n.parentAnchor || n.pendingInteraction
            ? ""
            : "bg-accent-muted/60 rounded-t-card"
        }`}
      >
        <div className="w-7 h-7 rounded-full bg-accent text-ink-inverse text-label flex items-center justify-center mt-0.5 shrink-0 font-medium">
          你
        </div>
        <div
          className={`flex-1 text-body text-ink leading-relaxed pt-1 font-medium min-w-0 ${
            // Peek pins the whole card to PEEK_CARD_HEIGHT with the body as the
            // flex-fill scroll area. A long question / many attachments would
            // otherwise grow this header unbounded, pushing the card past its
            // reserved footprint and over the child below — so cap + scroll it.
            data.isPeeked ? "max-h-[200px] overflow-y-auto" : ""
          }`}
        >
          {indexLabel && (
            <span className="mr-1.5 font-mono text-ui text-ink-faint tabular-nums font-normal inline-flex items-center gap-1">
              {indexLabel}
              {isUnread && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-unread"
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
        {data.isPeeked && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onTogglePeek(n.id);
            }}
            title="收起预览"
            aria-label="收起预览"
            className="shrink-0 mt-0.5 px-2 h-7 rounded-md bg-surface border border-line-strong text-ink-muted hover:bg-ink hover:text-ink-inverse hover:border-ink active:scale-95 flex items-center gap-1 text-label font-medium transition-colors shadow-raise"
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
              aria-hidden
            >
              <path d="M18 15l-6-6-6 6" />
            </svg>
            收起
          </button>
        )}
        <button
          onClick={goRead}
          title="线性阅读"
          aria-label="线性阅读"
          className="shrink-0 mt-0.5 px-2 h-7 rounded-md bg-surface border border-line-strong text-ink-muted hover:bg-ink hover:text-ink-inverse hover:border-ink active:scale-95 flex items-center gap-1 text-label font-medium transition-colors shadow-raise"
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
        className={`px-5 py-4 md-body text-body text-ink-muted overflow-y-auto nodrag nowheel nopan ${
          data.isPeeked ? "flex-1 min-h-0" : "max-h-[420px]"
        }`}
      >
        {isStreaming ? (
          <>
            <div
              ref={thinkingRef}
              style={{ display: "none" }}
              className="items-center gap-1.5 mb-1 text-ui text-ink-faint"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              思考中…
            </div>
            <div
              ref={streamRef}
              className="whitespace-pre-wrap break-words leading-relaxed"
            />
            <span className="streaming-cursor" />
          </>
        ) : n.response ? (
          <MarkdownBody cacheKey={n.id} content={n.response} />
        ) : (
          <EmptyResponseNotice
            hasToolCalls={
              (n.toolCalls?.length ?? 0) > 0 || (n.toolCallStats?.total ?? 0) > 0
            }
          />
        )}
        {errorSuperseded && (
          <SupersededErrorNotice nodeId={n.id} errorMessage={n.errorMessage} />
        )}
        {isError &&
          !errorSuperseded &&
          (n.errorMessage === "aborted" ? (
            <div className="mt-3 p-2 bg-surface-muted border border-line rounded text-ink-muted text-xs flex items-start gap-2">
              <div className="flex-1">已停止生成</div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  retryNode(n.id);
                }}
                className="shrink-0 px-2 py-0.5 rounded bg-accent text-ink-inverse text-label hover:bg-accent-strong active:scale-95 transition-transform"
              >
                ↻ 重新发送
              </button>
            </div>
          ) : (
            <div className="mt-3 p-2 bg-danger-muted border border-danger-line rounded text-danger-ink text-xs flex items-start gap-2">
              <div className="flex-1">
                出错：{n.errorMessage}
                {isAuthErrorMessage(n.errorMessage) && (
                  <a
                    href="/settings/models"
                    onClick={(e) => e.stopPropagation()}
                    className="block mt-1 underline underline-offset-2 opacity-80 hover:opacity-100"
                  >
                    像是 CLI 授权问题 → 查看授权状态
                  </a>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  retryNode(n.id);
                }}
                className="shrink-0 px-2 py-0.5 rounded bg-danger text-ink-inverse text-label hover:bg-danger-strong active:scale-95 transition-transform"
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
  if (prev.data.isPeeked !== next.data.isPeeked) return false;
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
    <div className="px-5 py-2 border-t border-line-faint flex items-center gap-2 text-xs text-ink-muted">
      {isStreaming ? (
        <>
          <span className="w-1.5 h-1.5 bg-positive rounded-full animate-pulse" />
          <span>正在生成…</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              abortStream(node.id);
            }}
            className="ml-2 px-2 py-0.5 rounded border border-line-strong bg-surface text-ink-muted hover:bg-ink hover:text-ink-inverse hover:border-ink active:scale-95 transition-colors flex items-center gap-1"
            title="停止生成 (Esc)"
            aria-label="停止生成"
          >
            <span className="inline-block w-2 h-2 bg-current rounded-[1px]" />
            停止
          </button>
        </>
      ) : (
        <>
          <ToolCallBadge
            toolCalls={node.toolCalls}
            stats={node.toolCallStats}
          />
          <TurnStatsMeta
            tokenCount={node.tokenCount}
            durationMs={node.durationMs}
            createdAt={node.createdAt}
            toolCalls={node.toolCalls}
            isStreaming={isStreaming}
            variant="full"
          />
          {node.response && (
            <CopyButton
              text={node.response}
              className="nodrag ml-2 px-2 py-0.5 rounded text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
            />
          )}
          <button
            onClick={() => setOpen(true)}
            className="ml-1 px-2 py-0.5 rounded text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
          >
            + 追问
          </button>
        </>
      )}
      <span className="ml-auto text-ink-faint italic text-label">
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
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  const provider = useSessionStore((s) => s.provider);
  const workspacePath = useSessionStore((s) => s.session?.workspacePath);
  const family = providerFamily(provider);
  const skillProvider = family === "codex" ? "codex" : "claude";
  const skillPrefix = family === "codex" ? "$" : "/";
  // Skills show in every mode; picking one in pure chat auto-enables 增强模式
  // (per-turn spawn flag — Header badge reflects it) so the skill can run.
  const matchedSkills = useSkillSuggestions(
    q,
    family !== "mock",
    skillProvider,
    workspacePath,
  );
  const pickSkill = (name: string) => {
    if (sessionMode === "chat" && !chatEnhanced) setChatEnhanced(true);
    setQ(`${skillPrefix}${name} `);
    ref.current?.focus();
  };
  const slashNav = useSlashNav(matchedSkills.length, q, (i) =>
    pickSkill(matchedSkills[i].name),
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
    <div className="relative border-t border-line-faint bg-surface-canvas/60">
      <SkillPickerList
        skills={matchedSkills}
        onPick={pickSkill}
        activeIndex={slashNav.active}
        skillPrefix={skillPrefix}
      />
      {/* px-1.5 insets the full-width textarea so its :focus-visible outline
          (globals.css — 2px solid + 2px offset, a non-layered rule utilities
          can't override) stays inside the card border instead of poking past
          it. */}
      <div className="px-1.5">
        <textarea
          ref={ref}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (slashNav.handleKeyDown(e)) return;
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
          className="w-full px-3.5 py-3 outline-none resize-none text-sm bg-transparent text-ink placeholder:text-ink-faint"
        />
      </div>
      <div className="px-3 py-1.5 flex items-center justify-end gap-2 text-xs">
        <button
          onClick={() => setZoneOpen(true)}
          title="专注写作模式（全屏 Markdown 编辑 + 预览）"
          className="mr-auto px-2 py-0.5 text-ink-muted hover:text-ink-strong inline-flex items-center gap-1"
        >
          <span aria-hidden>⛶</span>
          <span>专注写作</span>
        </button>
        <button
          onClick={onClose}
          className="px-2 py-0.5 text-ink-muted hover:text-ink-strong"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={!q.trim()}
          className="px-2.5 py-0.5 rounded bg-accent text-ink-inverse disabled:opacity-40 hover:bg-accent-strong"
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
// non-interactive — drill-down lives in the timeline inside the
// fullscreen view.
//
// 🔧 is every call in the turn; delegation gets its own 🤖 / ⚙ count so a turn
// that fanned out reads as such at a glance instead of just showing an
// inflated tool number.
//
// 大会话的 toolCalls 不随会话载荷下发（改发预计算 stats），所以 badge 优先
// 用 stats——省掉每个卡片一次 buildToolTree（91 节点实测 10ms，能省则省）。
function ToolCallBadge({
  toolCalls,
  stats,
}: {
  toolCalls: ToolCall[];
  stats?: ChatNodeData["toolCallStats"];
}) {
  let total = 0;
  let subagents = 0;
  let workflows = 0;
  let labels: string[] = [];
  if (toolCalls.length > 0) {
    const tree = buildToolTree(toolCalls);
    const counts = countToolTree(tree);
    total = counts.total;
    subagents = counts.subagents;
    workflows = counts.workflows;
    labels = walkToolTree(tree)
      .filter((n) => n.kind === "subagent")
      .map((n) => subagentLabel(n.meta));
  } else if (stats) {
    total = stats.total;
    subagents = stats.subagents;
    workflows = stats.workflows;
    labels = stats.labels;
  }
  if (total === 0) return null;
  return (
    <span className="shrink-0 inline-flex items-center gap-1 text-nano tabular-nums text-ink-muted">
      <span title={`本轮共 ${total} 次工具调用`}>🔧{total}</span>
      {subagents > 0 && (
        <span title={`派了 ${subagents} 个子 Agent：${labels.join("、")}`}>
          🤖{subagents}
        </span>
      )}
      {workflows > 0 && (
        <span title={`跑了 ${workflows} 个 Workflow`}>⚙{workflows}</span>
      )}
    </span>
  );
}
