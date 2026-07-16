"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore } from "@/stores/sessionStore";
import {
  subscribeStream,
  getStreamPending,
  thinkingChannel,
} from "@/lib/stream-bus";
import { refIcon } from "@/lib/ref-icon";
import { MD_COMPONENTS } from "@/lib/md-components";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useMarkdownBodyMarks } from "@/hooks/useMarkdownBodyMarks";
import type { ChatNode, NodeAttachment } from "@/lib/types";
import { AttachmentPreview } from "./AttachmentPreview";
import { CardImageButton } from "./CardImageButton";
import { CliResumeButton } from "./CliResumeButton";
import { CopyButton } from "./CopyButton";
import { GeneratedFilesBar } from "./GeneratedFilesBar";
import { InteractionForm } from "./InteractionForm";
import { ToolCallsPanel } from "./ToolCallsPanel";
import { Button } from "./ui/Button";
import { Dots } from "./ui/Dots";
import { StopButton } from "./ui/StopButton";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];
// A1: while streaming we render markdown live but skip rehypeRaw — mid-stream
// text often contains a half-typed HTML tag, and raw-HTML parsing on each
// frame is both wasteful and can throw on malformed fragments. Highlighting
// alone is enough for the live view; the final render uses REHYPE_FULL.
const REHYPE_STREAMING = [rehypeHighlight];

// #7: the single "turn" reading/interaction surface, shared by every place a
// node is read in full (the linear thread is the only consumer today — the
// old NodeFullView duplicated all of this and has been retired). Carries the
// complete capability set: parent-anchor jump banner, editable question,
// tool-call panel, mark-injected markdown body with live streaming, the
// action row (CLI resume / regenerate / card image / copy), generated files,
// and the paused-interaction form.
export function TurnCard({ node }: { node: ChatNode }) {
  const jumpToParentAtAnchor = useSessionStore((s) => s.jumpToParentAtAnchor);
  const hasParent = useSessionStore((s) =>
    Boolean(node.parentId && s.nodes[node.parentId]),
  );

  if (node.kind === "reference") {
    return <ReferenceFullBody key={node.id} node={node} />;
  }

  return (
    <>
      {node.parentAnchor && hasParent && (
        <button
          onClick={() => jumpToParentAtAnchor(node.parentId!, node.id)}
          className="w-full text-left mb-3 px-3 py-2 rounded-lg bg-fork-muted border border-fork-line text-ui text-fork-ink active:scale-[0.99] transition-transform shadow-raise hover:bg-fork-line/25"
          title="回到父节点的引用处 (B)"
        >
          <span className="text-fork mr-1">↳</span>
          从「
          <span className="font-medium">
            {truncate(node.parentAnchor.selectedText, 60)}
          </span>
          」分叉
          <span className="ml-1.5 text-fork-ink/70">
            · 点击或按
            <kbd className="mx-1 px-1 py-px rounded bg-fork-line/40 border border-fork-line font-mono text-nano">
              B
            </kbd>
            回到引用处
          </span>
        </button>
      )}
      <QuestionBlock
        nodeId={node.id}
        question={node.question}
        attachments={node.attachments}
      />
      <ToolCallsPanel toolCalls={node.toolCalls} />
      {/* key={node.id} forces a fresh ResponseBody fiber per node: the
          imperative <mark> injection inside react-markdown's output diverges
          from React's virtual tree, so when the node prop changes in-place
          React's reconciler tries to removeChild against DOM that was
          re-parented under our marks and throws NotFoundError. Unmounting
          cleanly lets the cleanup clearMarks() run before React touches the
          DOM. */}
      <ResponseBody key={node.id} node={node} />
      {/* A路③: when this node's run is paused on an interactive tool, render
          the answer form below the response so the user can reply in place
          and the model continues. */}
      {node.pendingInteraction && (
        <InteractionForm
          nodeId={node.id}
          interaction={node.pendingInteraction}
        />
      )}
    </>
  );
}

// D5: regenerate the same question as a NEW sibling (a second "version"),
// rather than overwriting in place like retry. The branch entries in the
// thread then let the user compare the variants side by side.
function RegenerateVariantButton({
  nodeId,
  question,
}: {
  nodeId: string;
  question: string;
}) {
  const editNode = useSessionStore((s) => s.editNode);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={(e) => {
        e.stopPropagation();
        editNode(nodeId, question);
      }}
      title="用相同问题再生成一个版本（新建兄弟节点，可在分支列表对比）"
      className="nodrag"
    >
      ↻ 再答一版
    </Button>
  );
}

function QuestionBlock({
  nodeId,
  question,
  attachments,
}: {
  nodeId: string;
  question: string;
  attachments: NodeAttachment[];
}) {
  const editNode = useSessionStore((s) => s.editNode);
  const sendKey = useSessionStore((s) => s.sendKey);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(question);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setEditing(false);
    editNode(nodeId, t);
  };
  const cancel = () => {
    setEditing(false);
    setText(question);
  };

  if (editing) {
    return (
      <div className="bg-accent-muted border border-accent-line rounded-lg px-4 py-3 mb-4">
        <textarea
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendCombo(e, sendKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          rows={3}
          className="w-full resize-none px-3 py-2 rounded-field border border-accent-line bg-surface text-reading text-ink-strong outline-none focus:border-accent leading-relaxed"
        />
        <div className="flex items-center justify-between gap-2 mt-2">
          <span className="text-label text-ink-faint min-w-0 truncate">
            改问法会新建一个分支，保留原问答（{sendHint(sendKey)}）
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={cancel}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={!text.trim()}
            >
              ↻ 重问
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group bg-accent-muted border-l-[3px] border-l-accent rounded-lg px-4 py-3 mb-5 flex items-start gap-3">
      <div className="w-7 h-7 rounded-full bg-accent text-ink-inverse text-label flex items-center justify-center shrink-0 font-medium shadow-raise">
        你
      </div>
      <div className="flex-1 text-reading text-ink leading-relaxed pt-1 font-medium whitespace-pre-wrap break-words min-w-0">
        {question}
        {attachments.length > 0 && (
          <div className="mt-2 font-normal">
            <AttachmentPreview attachments={attachments} readOnly />
          </div>
        )}
      </div>
      <button
        onClick={() => {
          setText(question);
          setEditing(true);
        }}
        title="编辑问题（会新建一个分支重问）"
        aria-label="编辑问题"
        className="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-md text-ink-muted opacity-60 sm:opacity-0 group-hover:opacity-100 hover:bg-surface-raised hover:text-accent transition-opacity"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </div>
  );
}

// Dim auto-scrolling viewport for the live thinking stream. Pinned to the
// bottom as text grows (thinking is transient status, not reading material —
// following the tail beats preserving scroll position).
function ThinkingScroll({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div
      ref={ref}
      className={`max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-faint ${className ?? ""}`}
    >
      {text}
    </div>
  );
}

function ResponseBody({ node }: { node: ChatNode }) {
  const retryNode = useSessionStore((s) => s.retryNode);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isStreaming = node.status === "streaming";
  const isError = node.status === "error";

  const { onMarkClick } = useMarkdownBodyMarks({
    bodyRef,
    nodeId: node.id,
    contentVersion: node.response,
    suspended: isStreaming,
  });

  // A1: live markdown render while streaming. Accumulate deltas in a ref and
  // flush to state on requestAnimationFrame (coalescing token bursts to one
  // re-render per frame), then render through ReactMarkdown so code/lists/
  // tables format as they arrive — matching GPT/Claude. Affordable here
  // because turn cards live in a plain scroll list, not inside the ReactFlow
  // canvas (ChatNode deliberately keeps the textContent-direct sink there).
  const [liveText, setLiveText] = useState("");
  useEffect(() => {
    if (!isStreaming) return;
    let raf = 0;
    let buf = node.response + getStreamPending(node.id);
    setLiveText(buf);
    const flush = () => {
      raf = 0;
      setLiveText(buf);
    };
    const unsub = subscribeStream(node.id, (delta) => {
      buf += delta;
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, node.id]);

  // Extended thinking: claude streams a thinking block BEFORE the text block
  // (minutes under high effort). Same rAF-coalesced bus subscription as the
  // text deltas, separate channel. Ephemeral — vanishes when the turn ends.
  const [liveThinking, setLiveThinking] = useState("");
  useEffect(() => {
    if (!isStreaming) {
      setLiveThinking("");
      return;
    }
    let raf = 0;
    let buf = getStreamPending(thinkingChannel(node.id));
    setLiveThinking(buf);
    const flush = () => {
      raf = 0;
      setLiveThinking(buf);
    };
    const unsub = subscribeStream(thinkingChannel(node.id), (delta) => {
      buf += delta;
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
  }, [isStreaming, node.id]);

  return (
    <div
      ref={bodyRef}
      data-chat-node-id={node.id}
      onClick={onMarkClick}
      className="md-body text-reading text-ink leading-relaxed"
    >
      {isStreaming && liveThinking && (
        // The思考期 surface. While no answer text yet: an open dim panel with
        // the thinking stream (this is what used to look like a dead UI for
        // up to minutes). Once the answer starts: collapse to a <details>
        // (uncontrolled so a user toggle sticks). Gone entirely at done.
        liveText ? (
          <details className="mb-2">
            <summary className="cursor-pointer select-none text-ui text-ink-faint hover:text-ink-muted">
              🧠 思考过程（{liveThinking.length} 字）
            </summary>
            <ThinkingScroll text={liveThinking} className="mt-1" />
          </details>
        ) : (
          <div className="mb-2 rounded-md border border-line/70 bg-surface-muted/60 px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-ui text-ink-faint">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              思考中…
            </div>
            <ThinkingScroll text={liveThinking} />
          </div>
        )
      )}
      {isStreaming ? (
        liveText ? (
          <>
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={REHYPE_STREAMING}
              components={MD_COMPONENTS}
            >
              {liveText}
            </ReactMarkdown>
            <span className="streaming-cursor" />
          </>
        ) : liveThinking ? null : (
          // First token hasn't arrived yet — show an animated indicator
          // instead of a blank pane (the "no streaming" complaint).
          <div className="flex items-center gap-1.5 py-2 text-ink-faint">
            <Dots />
            <span className="ml-1.5 text-ui">正在生成…</span>
          </div>
        )
      ) : node.response ? (
        <>
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_FULL}
            components={MD_COMPONENTS}
          >
            {node.response}
          </ReactMarkdown>
          <div className="mt-3 flex justify-end gap-2">
            <CliResumeButton nodeId={node.id} />
            <RegenerateVariantButton nodeId={node.id} question={node.question} />
            <CardImageButton
              title={node.topicLabel ?? node.question}
              content={node.response}
            />
            <CopyButton
              text={node.response}
              label="复制全文"
              className="nodrag px-2.5 py-1 rounded border border-line text-ui text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
            />
          </div>
          <GeneratedFilesBar node={node} />
        </>
      ) : (
        <div className="text-ink-faint italic flex items-center gap-2">
          <span className="w-1.5 h-1.5 bg-positive rounded-full animate-pulse" />
          正在生成…
        </div>
      )}
      {isError &&
        (node.errorMessage === "aborted" ? (
          <div className="mt-3 p-2.5 bg-surface-muted border border-line rounded text-ink-muted text-ui flex items-start gap-2">
            <div className="flex-1">已停止生成</div>
            <Button
              variant="primary"
              size="sm"
              className="shrink-0"
              onClick={() => retryNode(node.id)}
            >
              ↻ 重新发送
            </Button>
          </div>
        ) : (
          <div className="mt-3 p-2.5 bg-danger-muted border border-danger-line rounded text-danger-ink text-ui flex items-start gap-2">
            <div className="flex-1">出错：{node.errorMessage}</div>
            <Button
              variant="danger"
              size="sm"
              className="shrink-0"
              onClick={() => retryNode(node.id)}
            >
              ↻ 重新生成
            </Button>
          </div>
        ))}
    </div>
  );
}

function ReferenceFullBody({ node }: { node: ChatNode }) {
  const refreshReference = useSessionStore((s) => s.refreshReference);
  const abortStream = useSessionStore((s) => s.abortStream);
  const fetchProgress = useSessionStore((s) => s.fetchProgress[node.id]);
  const [refreshing, setRefreshing] = useState(false);
  const ref = node.reference;
  const isStreaming = node.status === "streaming";
  const bodyRef = useRef<HTMLDivElement>(null);
  const { onMarkClick } = useMarkdownBodyMarks({
    bodyRef,
    nodeId: node.id,
    contentVersion: ref?.contentMd ?? "",
    suspended: isStreaming,
  });
  if (!ref) {
    return (
      <div className="text-ink-faint italic text-sm">参考卡片数据缺失</div>
    );
  }
  const canRefresh = ref.sourceType === "url" && !isStreaming;
  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshReference(node.id);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div
        className={`mb-4 px-4 py-3 rounded-lg border text-ui flex items-start gap-2.5 ${
          isStreaming
            ? "bg-accent-muted border-accent-line"
            : "bg-warn-muted border-warn-line"
        }`}
      >
        <span className="text-title leading-none mt-0.5" aria-hidden>
          {isStreaming ? "⏳" : refIcon(ref)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-ink-strong truncate">
            {node.topicLabel ?? "参考材料"}
          </div>
          {ref.sourceUri && (
            <a
              href={ref.sourceUri}
              target="_blank"
              rel="noreferrer"
              className={`block mt-0.5 truncate underline-offset-2 hover:underline ${
                isStreaming ? "text-accent-ink" : "text-warn-ink"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {ref.sourceUri}
            </a>
          )}
          {ref.meta.fetchError && !isStreaming && (
            <div className="mt-1 text-danger-ink text-ui">
              ⚠️ 抓取失败：{ref.meta.fetchError}
            </div>
          )}
        </div>
        {isStreaming ? (
          <StopButton
            label="停止"
            onClick={() => abortStream(node.id)}
            className="shrink-0"
            title="停止抓取"
          />
        ) : (
          canRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="shrink-0 px-2 py-1 text-label rounded border border-warn-line text-warn-ink hover:bg-warn-line/25 active:scale-95 disabled:opacity-50 transition-colors"
              title="重新抓取"
            >
              {refreshing ? "抓取中…" : "↻ 刷新"}
            </button>
          )
        )}
      </div>

      {isStreaming && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-surface-muted border border-line">
          <div className="flex items-center gap-2 text-ui text-ink-muted">
            <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
            <span className="font-medium">{fetchProgress || "启动中…"}</span>
          </div>
          <div className="mt-2 text-label text-ink-faint leading-relaxed">
            claude 正在挑选并运行合适的 skill 抓取这个 URL。
            飞书 / YouTube / B站 等通常 5–60 秒，PDF / 大型文档可能更久。
            可以随时点上方"停止"取消。
          </div>
        </div>
      )}

      <div
        ref={bodyRef}
        data-chat-node-id={node.id}
        onClick={onMarkClick}
        className="md-body text-reading text-ink leading-relaxed"
      >
        {ref.contentMd ? (
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_FULL}
            components={MD_COMPONENTS}
          >
            {ref.contentMd}
          </ReactMarkdown>
        ) : isStreaming ? null : (
          <div className="text-ink-faint italic text-sm">
            {ref.meta.fetchError
              ? "抓取失败，没有内容可显示。点上方刷新重试，或编辑后重新粘贴。"
              : "（没有正文）"}
          </div>
        )}
      </div>
    </>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
