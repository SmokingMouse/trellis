"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore } from "@/stores/sessionStore";
import { ancestorsOf } from "@/lib/collapsed";
import { buildNodeIndex } from "@/lib/node-index";
import { getStreamPending, subscribeStream } from "@/lib/stream-bus";
import { MD_COMPONENTS } from "@/lib/md-components";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { useAttachmentUploads } from "@/hooks/useAttachmentUploads";
import type { ChatNode } from "@/lib/types";
import { AttachmentPreview } from "./AttachmentPreview";
import { CliResumeButton } from "./CliResumeButton";
import { CopyButton } from "./CopyButton";
import { InteractionForm } from "./InteractionForm";
import { ThreadMinimap } from "./ThreadMinimap";
import { ToolCallsPanel } from "./ToolCallsPanel";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];
const REHYPE_STREAMING = [rehypeHighlight];

function nodeSort(a: ChatNode, b: ChatNode) {
  return (
    a.siblingIndex - b.siblingIndex ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function firstRoot(nodes: Record<string, ChatNode>, rootNodeId?: string | null) {
  if (rootNodeId && nodes[rootNodeId]) return nodes[rootNodeId];
  return Object.values(nodes)
    .filter((n) => !n.parentId)
    .sort(nodeSort)[0] ?? null;
}

function childrenIndex(nodes: Record<string, ChatNode>) {
  const byParent = new Map<string, ChatNode[]>();
  for (const n of Object.values(nodes)) {
    if (!n.parentId) continue;
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  for (const arr of byParent.values()) arr.sort(nodeSort);
  return byParent;
}

export function LinearThreadView() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setFullScreen = useSessionStore((s) => s.setFullScreen);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const nodeIndices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const [openBranches, setOpenBranches] = useState<Set<string>>(new Set());
  const roundRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    setOpenBranches(new Set());
  }, [session?.id]);

  const threadData = useMemo(() => {
    const anchor =
      activeNodeId && nodes[activeNodeId]
        ? nodes[activeNodeId]
        : firstRoot(nodes, session?.rootNodeId);
    if (!anchor) {
      return {
        anchorId: null,
        thread: [] as ChatNode[],
        branchesByNode: new Map<string, ChatNode[]>(),
      };
    }

    const byParent = childrenIndex(nodes);
    const up = ancestorsOf(anchor.id, nodes)
      .reverse()
      .map((id) => nodes[id])
      .filter((n): n is ChatNode => Boolean(n));
    const down: ChatNode[] = [];
    let cur: ChatNode | undefined = anchor;
    while (cur) {
      const child: ChatNode | undefined = byParent.get(cur.id)?.[0];
      if (!child) break;
      down.push(child);
      cur = child;
    }
    const thread = [...up, anchor, ...down];
    const nextByNode = new Map<string, string>();
    for (let i = 0; i < thread.length - 1; i++) {
      nextByNode.set(thread[i].id, thread[i + 1].id);
    }
    const branchesByNode = new Map<string, ChatNode[]>();
    for (const n of thread) {
      const nextId = nextByNode.get(n.id);
      const branches = (byParent.get(n.id) ?? []).filter((c) => c.id !== nextId);
      if (branches.length > 0) branchesByNode.set(n.id, branches);
    }
    return { anchorId: anchor.id, thread, branchesByNode };
  }, [activeNodeId, nodes, session?.rootNodeId]);

  useEffect(() => {
    if (!threadData.anchorId) return;
    const id = requestAnimationFrame(() => {
      roundRefs.current
        .get(threadData.anchorId!)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [threadData.anchorId]);

  const setRoundRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) roundRefs.current.set(id, el);
    else roundRefs.current.delete(id);
  };

  const toggleBranches = (nodeId: string) => {
    setOpenBranches((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const tipNode =
    threadData.thread.length > 0
      ? threadData.thread[threadData.thread.length - 1]
      : null;

  if (!session) return null;

  return (
    <div
      className="w-screen h-screen pt-[5.25rem] overflow-y-auto bg-stone-50 dark:bg-stone-950"
      style={{ paddingLeft: "var(--trellis-sb, 0px)", boxSizing: "border-box" }}
    >
      <div className="sticky top-0 z-30 border-b border-stone-200/80 dark:border-stone-800 bg-stone-50/90 dark:bg-stone-950/90 backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Project thread
            </div>
            <h1 className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">
              {session.title}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setViewMode("canvas")}
            className="shrink-0 px-3 py-1.5 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 active:scale-95 transition"
          >
            🗺 画布
          </button>
        </div>
      </div>

      <main className="max-w-3xl mx-auto px-4 py-5 pb-6 space-y-4">
        {threadData.thread.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 px-4 py-8 text-center text-sm text-stone-500 dark:text-stone-400">
            暂无节点
          </div>
        ) : (
          threadData.thread.map((node, idx) => {
            const branches = threadData.branchesByNode.get(node.id) ?? [];
            const isActive = node.id === threadData.anchorId;
            return (
              <section
                key={node.id}
                ref={setRoundRef(node.id)}
                data-thread-node-id={node.id}
                className={`rounded-lg border bg-white dark:bg-stone-900 shadow-sm transition-colors ${
                  isActive
                    ? "border-indigo-300 dark:border-indigo-700 ring-2 ring-indigo-100 dark:ring-indigo-950"
                    : "border-stone-200 dark:border-stone-800"
                }`}
              >
                <div className="px-4 py-3 border-b border-stone-100 dark:border-stone-800 flex items-center gap-2 text-xs">
                  <span className="font-mono text-stone-400 dark:text-stone-500">
                    #{nodeIndices[node.id] ?? idx + 1}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      node.status === "streaming"
                        ? "bg-indigo-500 animate-pulse"
                        : node.status === "error"
                          ? "bg-rose-500"
                          : node.readAt
                            ? "bg-stone-300 dark:bg-stone-600"
                            : "bg-amber-400"
                    }`}
                  />
                  <span className="text-stone-500 dark:text-stone-400">
                    {node.kind === "reference" ? "Reference" : "Turn"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveNode(node.id);
                      setViewMode("canvas");
                      setFullScreen(true);
                    }}
                    className="ml-auto px-2 py-1 rounded-md text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors flex items-center gap-1"
                    title="进入对话"
                    aria-label="进入对话"
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
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>聊</span>
                  </button>
                </div>

                <div className="px-4 py-4 space-y-4">
                  {node.kind === "reference" ? (
                    <ReferenceSummary node={node} />
                  ) : (
                    <>
                      <QuestionBlock node={node} />
                      <ToolCallsPanel toolCalls={node.toolCalls} />
                      <ThreadResponseBody node={node} />
                      {node.pendingInteraction && (
                        <InteractionForm
                          nodeId={node.id}
                          interaction={node.pendingInteraction}
                        />
                      )}
                    </>
                  )}

                  {branches.length > 0 && (
                    <div className="pt-2 border-t border-stone-100 dark:border-stone-800">
                      <button
                        type="button"
                        onClick={() => toggleBranches(node.id)}
                        className="text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100"
                      >
                        ↳ {branches.length} 个分支
                      </button>
                      {openBranches.has(node.id) && (
                        <div className="mt-2 space-y-1.5">
                          {branches.map((branch) => (
                            <button
                              key={branch.id}
                              type="button"
                              onClick={() => setActiveNode(branch.id)}
                              className="w-full text-left px-3 py-2 rounded-lg bg-amber-50/70 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/70 hover:bg-amber-100 dark:hover:bg-amber-950/60 transition-colors"
                            >
                              <div className="flex items-center gap-2 text-[11px] text-amber-700/80 dark:text-amber-300/80">
                                <span className="font-mono">
                                  #{nodeIndices[branch.id] ?? "?"}
                                </span>
                                <span>{branch.kind === "reference" ? "reference" : "branch"}</span>
                              </div>
                              <div className="mt-0.5 truncate text-xs text-stone-700 dark:text-stone-200">
                                {branch.topicLabel ?? truncate(branch.question, 120)}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            );
          })
        )}
      </main>
      {tipNode && (
        <div className="sticky bottom-0 z-20 border-t border-stone-200/80 dark:border-stone-800 bg-stone-50/95 dark:bg-stone-950/95 backdrop-blur">
          <div className="max-w-3xl mx-auto px-4">
            <LinearComposer tipNode={tipNode} />
          </div>
        </div>
      )}
      <ThreadMinimap />
    </div>
  );
}

function LinearComposer({ tipNode }: { tipNode: ChatNode }) {
  const [text, setText] = useState("");
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const abortStream = useSessionStore((s) => s.abortStream);
  const sendKey = useSessionStore((s) => s.sendKey);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isStreaming = tipNode.status === "streaming";
  // Linear view only ever renders for project sessions, which are always
  // tool-capable — no chatEnhanced gate needed here (unlike QuestionInput).
  const matchedSkills = useSkillSuggestions(text, true);
  const att = useAttachmentUploads("all");

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
    }
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || att.hasUploading) return;
    const attachments =
      att.doneAttachments.length > 0 ? att.doneAttachments : undefined;
    setText("");
    // This composer stays mounted after submit (unlike QuestionInput /
    // BranchPopover which unmount) — clear so the next turn starts fresh.
    att.clear();
    streamBranch(tipNode.id, trimmed, null, { attachments });
  };

  if (isStreaming) {
    return (
      <div className="py-3">
        <button
          onClick={() => abortStream(tipNode.id)}
          className="w-full h-[42px] rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-300 hover:bg-stone-900 hover:text-white hover:border-stone-900 dark:hover:bg-stone-100 dark:hover:text-stone-900 dark:hover:border-stone-100 active:scale-[0.99] transition-colors flex items-center justify-center gap-2 text-[13px]"
          aria-label="停止生成"
        >
          <span className="inline-block w-2.5 h-2.5 bg-current rounded-[2px]" />
          停止生成
          <span className="opacity-60 text-[11px] hidden sm:inline">
            （Esc）
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="relative py-3">
      {att.pending.length > 0 && (
        <div className="mb-2">
          <AttachmentPreview pending={att.pending} onRemove={att.remove} />
        </div>
      )}
      {att.notice && (
        <div className="mb-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          {att.notice}
        </div>
      )}
      <div className="flex items-end gap-2">
      {matchedSkills.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-10 border border-stone-200 dark:border-stone-700 rounded-lg bg-white dark:bg-stone-900 shadow-lg overflow-hidden max-h-56 overflow-y-auto">
          {matchedSkills.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => {
                setText(`/${s.name} `);
                ref.current?.focus();
              }}
              className="w-full text-left px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800 border-b last:border-b-0 border-stone-100 dark:border-stone-800"
            >
              <div className="text-[13px] font-mono text-stone-800 dark:text-stone-200">
                /{s.name}
              </div>
              {s.description && (
                <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate">
                  {s.description}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isSendCombo(e, sendKey)) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={att.handlePaste}
        rows={1}
        placeholder={`继续对话…（${sendHint(sendKey)}，可粘贴图片 / 文件）`}
        className="flex-1 min-h-[44px] max-h-[160px] resize-none px-4 py-3 rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-[14.5px] text-stone-900 dark:text-stone-100 outline-none focus:border-indigo-400 dark:focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 placeholder:text-stone-400 dark:placeholder:text-stone-500 transition-shadow shadow-sm"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={att.accept}
        multiple
        onChange={att.handlePicked}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={att.atLimit}
        title={att.atLimit ? "已到附件上限" : "添加图片 / 文件"}
        className="shrink-0 h-[44px] w-[44px] rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-500 dark:text-stone-400 flex items-center justify-center disabled:opacity-30 hover:text-stone-800 dark:hover:text-stone-200 hover:border-stone-400 dark:hover:border-stone-500 active:scale-95 transition-all shadow-sm"
        aria-label="添加附件"
      >
        <span aria-hidden>📎</span>
      </button>
      <button
        onClick={submit}
        disabled={!text.trim() || att.hasUploading}
        title={att.hasUploading ? "等待附件上传…" : undefined}
        className="shrink-0 h-[44px] w-[44px] rounded-2xl bg-indigo-600 text-white flex items-center justify-center disabled:opacity-30 hover:bg-indigo-700 active:scale-95 transition-all shadow-sm"
        aria-label="发送"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </button>
      </div>
    </div>
  );
}

function QuestionBlock({ node }: { node: ChatNode }) {
  return (
    <div className="rounded-lg bg-stone-50 dark:bg-stone-950/50 border border-stone-100 dark:border-stone-800 px-3 py-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
        You
      </div>
      {node.attachments.length > 0 && (
        <div className="mb-2">
          <AttachmentPreview attachments={node.attachments} readOnly />
        </div>
      )}
      <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-stone-900 dark:text-stone-100">
        {node.question}
      </div>
    </div>
  );
}

function ReferenceSummary({ node }: { node: ChatNode }) {
  const ref = node.reference;
  const title = ref?.meta.title ?? node.topicLabel ?? node.question;
  return (
    <div className="rounded-lg bg-amber-50/80 dark:bg-amber-950/25 border border-amber-100 dark:border-amber-900/70 px-3 py-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700/70 dark:text-amber-300/70">
        Reference
      </div>
      <div className="text-[15px] font-medium text-stone-900 dark:text-stone-100">
        {title || "参考资料"}
      </div>
      {ref?.sourceUri && (
        <a
          href={ref.sourceUri}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block truncate text-xs text-indigo-600 dark:text-indigo-300 hover:underline"
        >
          {ref.sourceUri}
        </a>
      )}
      {typeof ref?.meta.wordCount === "number" && (
        <div className="mt-2 text-[11px] text-stone-500 dark:text-stone-400 tabular-nums">
          {ref.meta.wordCount.toLocaleString()} words
        </div>
      )}
    </div>
  );
}

function ThreadResponseBody({ node }: { node: ChatNode }) {
  const isStreaming = node.status === "streaming";
  const isError = node.status === "error";
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

  const text = isStreaming ? liveText : node.response;

  return (
    <div className="space-y-3">
      <div
        data-chat-node-id={node.id}
        className="md-body text-[15px] leading-relaxed text-stone-800 dark:text-stone-200"
      >
        {text ? (
          <>
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={isStreaming ? REHYPE_STREAMING : REHYPE_FULL}
              components={MD_COMPONENTS}
            >
              {text}
            </ReactMarkdown>
            {isStreaming && <span className="streaming-cursor" />}
          </>
        ) : isStreaming ? (
          <div className="flex items-center gap-1.5 py-2 text-stone-400 dark:text-stone-500">
            <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse [animation-delay:150ms]" />
            <span className="w-2 h-2 rounded-full bg-indigo-300 animate-pulse [animation-delay:300ms]" />
            <span className="ml-1.5 text-[13px]">正在生成…</span>
          </div>
        ) : (
          <div className="text-stone-400 dark:text-stone-500 italic">
            （暂无回答）
          </div>
        )}
      </div>

      {isError && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/35 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          出错：{node.errorMessage ?? "unknown error"}
        </div>
      )}

      {text && (
        <div className="flex justify-end gap-2">
          <CliResumeButton nodeId={node.id} />
          <CopyButton
            text={text}
            label="复制全文"
            className="nodrag px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
          />
        </div>
      )}
    </div>
  );
}
