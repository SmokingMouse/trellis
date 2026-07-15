"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore } from "@/stores/sessionStore";
import { subscribeStream, getStreamPending } from "@/lib/stream-bus";
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
          className="w-full text-left mb-3 px-3 py-2 rounded-lg bg-amber-50/95 dark:bg-amber-950/70 border border-amber-200 dark:border-amber-900 text-[12px] text-amber-900 dark:text-amber-200 active:scale-[0.99] transition-transform shadow-sm hover:bg-amber-100 dark:hover:bg-amber-950"
          title="回到父节点的引用处 (B)"
        >
          <span className="text-amber-600 dark:text-amber-400 mr-1">↳</span>
          从「
          <span className="font-medium">
            {truncate(node.parentAnchor.selectedText, 60)}
          </span>
          」分叉
          <span className="ml-1.5 text-amber-700/70 dark:text-amber-300/60">
            · 点击或按
            <kbd className="mx-1 px-1 py-px rounded bg-amber-100 dark:bg-amber-900/60 border border-amber-200 dark:border-amber-800 font-mono text-[10px]">
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
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        editNode(nodeId, question);
      }}
      title="用相同问题再生成一个版本（新建兄弟节点，可在分支列表对比）"
      className="nodrag px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
    >
      ↻ 再答一版
    </button>
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
      <div className="bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900 rounded-lg px-4 py-3 mb-4">
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
          className="w-full resize-none px-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-white dark:bg-stone-900 text-[15px] text-stone-900 dark:text-stone-100 outline-none focus:border-indigo-400 dark:focus:border-indigo-600 leading-relaxed"
        />
        <div className="flex items-center justify-between gap-2 mt-2">
          <span className="text-[11px] text-stone-400 dark:text-stone-500 min-w-0 truncate">
            改问法会新建一个分支，保留原问答（{sendHint(sendKey)}）
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={cancel}
              className="px-2.5 py-1 text-[12px] text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
            >
              取消
            </button>
            <button
              onClick={submit}
              disabled={!text.trim()}
              className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-[12px] disabled:opacity-40 hover:bg-indigo-700 active:scale-95 transition-transform"
            >
              ↻ 重问
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group bg-indigo-50/60 dark:bg-indigo-950/30 border-l-[3px] border-l-indigo-500 rounded-lg px-4 py-3 mb-5 flex items-start gap-3">
      <div className="w-7 h-7 rounded-full bg-indigo-500 text-white text-[11px] flex items-center justify-center shrink-0 font-medium shadow-sm">
        你
      </div>
      <div className="flex-1 text-[15px] text-stone-800 dark:text-stone-200 leading-relaxed pt-1 font-medium whitespace-pre-wrap min-w-0">
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
        className="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-md text-stone-500 dark:text-stone-400 opacity-60 sm:opacity-0 group-hover:opacity-100 hover:bg-white dark:hover:bg-stone-800 hover:text-indigo-600 dark:hover:text-indigo-400 transition-opacity"
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

  return (
    <div
      ref={bodyRef}
      data-chat-node-id={node.id}
      onClick={onMarkClick}
      className="md-body text-[15px] text-stone-800 dark:text-stone-200 leading-relaxed"
    >
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
        ) : (
          // First token hasn't arrived yet — show an animated indicator
          // instead of a blank pane (the "no streaming" complaint).
          <div className="flex items-center gap-1.5 py-2 text-stone-400 dark:text-stone-500">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse [animation-delay:150ms]" />
            <span className="w-2 h-2 rounded-full bg-indigo-300 animate-pulse [animation-delay:300ms]" />
            <span className="ml-1.5 text-[13px]">正在生成…</span>
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
              className="nodrag px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
            />
          </div>
          <GeneratedFilesBar node={node} />
        </>
      ) : (
        <div className="text-stone-400 dark:text-stone-500 italic flex items-center gap-2">
          <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          正在生成…
        </div>
      )}
      {isError &&
        (node.errorMessage === "aborted" ? (
          <div className="mt-3 p-2.5 bg-stone-50 dark:bg-stone-800/60 border border-stone-200 dark:border-stone-700 rounded text-stone-600 dark:text-stone-300 text-[13px] flex items-start gap-2">
            <div className="flex-1">已停止生成</div>
            <button
              onClick={() => retryNode(node.id)}
              className="shrink-0 px-2.5 py-1 rounded bg-stone-700 dark:bg-stone-600 text-white text-xs hover:bg-stone-900 dark:hover:bg-stone-500 active:scale-95 transition-transform"
            >
              ↻ 重新发送
            </button>
          </div>
        ) : (
          <div className="mt-3 p-2.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-rose-700 dark:text-rose-300 text-[13px] flex items-start gap-2">
            <div className="flex-1">出错：{node.errorMessage}</div>
            <button
              onClick={() => retryNode(node.id)}
              className="shrink-0 px-2.5 py-1 rounded bg-rose-600 text-white text-xs hover:bg-rose-700 active:scale-95 transition-transform"
            >
              ↻ 重新生成
            </button>
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
      <div className="text-stone-400 italic text-sm">参考卡片数据缺失</div>
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
        className={`mb-4 px-4 py-3 rounded-lg border text-[13px] flex items-start gap-2.5 ${
          isStreaming
            ? "bg-indigo-50/60 dark:bg-indigo-950/30 border-indigo-200 dark:border-indigo-900"
            : "bg-amber-50/60 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900"
        }`}
      >
        <span className="text-[18px] leading-none mt-0.5" aria-hidden>
          {isStreaming ? "⏳" : refIcon(ref)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-stone-900 dark:text-stone-100 truncate">
            {node.topicLabel ?? "参考材料"}
          </div>
          {ref.sourceUri && (
            <a
              href={ref.sourceUri}
              target="_blank"
              rel="noreferrer"
              className={`block mt-0.5 truncate underline-offset-2 hover:underline ${
                isStreaming
                  ? "text-indigo-800 dark:text-indigo-300 hover:text-indigo-950 dark:hover:text-indigo-200"
                  : "text-amber-800 dark:text-amber-300 hover:text-amber-950 dark:hover:text-amber-200"
              }`}
              onClick={(e) => e.stopPropagation()}
            >
              {ref.sourceUri}
            </a>
          )}
          {ref.meta.fetchError && !isStreaming && (
            <div className="mt-1 text-rose-700 dark:text-rose-300 text-[12px]">
              ⚠️ 抓取失败：{ref.meta.fetchError}
            </div>
          )}
        </div>
        {isStreaming ? (
          <button
            onClick={() => abortStream(node.id)}
            className="shrink-0 px-2 py-1 text-[11px] rounded border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-700 dark:hover:text-rose-300 hover:border-rose-300 dark:hover:border-rose-800 active:scale-95 transition-colors"
            title="停止抓取"
          >
            停止
          </button>
        ) : (
          canRefresh && (
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="shrink-0 px-2 py-1 text-[11px] rounded border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/60 active:scale-95 disabled:opacity-50 transition-colors"
              title="重新抓取"
            >
              {refreshing ? "抓取中…" : "↻ 刷新"}
            </button>
          )
        )}
      </div>

      {isStreaming && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-800">
          <div className="flex items-center gap-2 text-[13px] text-stone-700 dark:text-stone-300">
            <span className="inline-block w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
            <span className="font-medium">{fetchProgress || "启动中…"}</span>
          </div>
          <div className="mt-2 text-[11px] text-stone-400 dark:text-stone-500 leading-relaxed">
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
        className="md-body text-[15px] text-stone-800 dark:text-stone-200 leading-relaxed"
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
          <div className="text-stone-400 dark:text-stone-500 italic text-sm">
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
