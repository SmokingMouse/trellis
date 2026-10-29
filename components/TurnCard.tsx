"use client";
import { parseNodeRefs } from "@/lib/node-refs";
import { NodeRefCards } from "./NodeRefChips";
import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  AtSign,
  Brain,
  ChevronRight,
  CircleCheck,
  CircleDot,
  Copy,
  Check,
  Ellipsis,
  FileText,
  GitBranch,
  Link2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import {
  subscribeStream,
  getStreamPending,
  thinkingChannel,
} from "@/lib/stream-bus";
import { isAuthErrorMessage } from "@/lib/auth-error";
import { copyText } from "@/lib/clipboard";
import { formatDuration } from "@/lib/format-duration";
import { toolTitle } from "@/lib/tool-registry";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "@/lib/md-components";
import { MarkdownStreamingContext } from "@/lib/markdown-streaming";
import {
  MARKDOWN_REMARK_PLUGINS,
  MARKDOWN_STREAMING_REHYPE_PLUGINS,
} from "@/lib/markdown-plugins";
import { MarkdownBody } from "@/lib/markdown-cache";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useMarkdownBodyMarks } from "@/hooks/useMarkdownBodyMarks";
import { useNearViewport } from "@/hooks/useNearViewport";
import type { ChatNode, NodeAttachment } from "@/lib/types";
import {
  ActionSheet,
  Button,
  ErrorCallout,
  Icon,
  IconButton,
  Kbd,
  Spinner,
  StatusDot,
  StopButton,
} from "@/components/ui";
import { Collapse } from "@/components/ui/Collapse";
import { AttachmentPreview } from "./AttachmentPreview";
import { CardImageButton } from "./CardImageButton";
import { CliResumeButton } from "./CliResumeButton";
import { CopyButton } from "./CopyButton";
import { EmptyResponseNotice } from "./EmptyResponseNotice";
import { GeneratedFilesBar } from "./GeneratedFilesBar";
import { InteractionForm } from "./InteractionForm";
import { AsProjectControls } from "./AsProjectControls";
import { SupersededErrorNotice } from "./SupersededErrorNotice";
import { ToolTimeline } from "./tools/ToolTimeline";
import { TurnStatsMeta, useElapsed } from "./TurnStatsMeta";
import { BookmarkButton } from "./BookmarkButton";

// 流式期间只做最小 rehype：rehypeRaw 跳过（半行 HTML 标签既浪费又可能抛错），
// rehypeHighlight 也跳过——它会在每一帧对**整段** response 重跑语法高亮，
// 几百 KB 的长回复能把主线程卡死，正是「tab 点不开」的主因。高亮只在 done
// 态跑一次；流式态只保留数学公式渲染。

// #7 + W3「无框连续流」：一轮 = 用户消息（浅灰块）+ 工具轨迹 + 全宽正文 +
// hover 才浮出的轻工具栏。不再有卡片外框、卡头「#序号 · 状态点 · Turn」和
// 圆形「你」头像：序号 / 未读点挪到用户消息左侧槽位，已读 / 收藏 / 分叉 /
// 删除 / 耗时 / 复制 / 卡片图收进每轮底部的工具栏（手机端常显）。
//
// React.memo：线性 thread 订阅整个 `nodes` 对象，流式期间每个 tool_call
// 事件（合批后仍是每帧一次）都会让父组件重渲。未变的节点（同引用）直接跳
// 过——避免 15 张已完成卡片每次都重跑完整语法高亮。所以这里只收原始值和
// 稳定回调（父组件用 useCallback / store action），不收 ReactNode。
export type TurnCardProps = {
  node: ChatNode;
  readOnly?: boolean;
  /** 线性视图里的全局序号（#N），缺省不显示 */
  index?: number | string;
  /** 当前锚点（导航目标）——序号常显、accent 色 */
  isActive?: boolean;
  /** 可从本节点分叉（线性视图：非流式、非 tip） */
  canBranch?: boolean;
  /** 底部 composer 正指向本节点（分叉 chip 已激活） */
  branchArmed?: boolean;
  onBranch?: (nodeId: string) => void;
  canDelete?: boolean;
  onDelete?: (nodeId: string) => void;
  /**
   * 镜像会话（Herdr 窗格里的 Claude Code）这一轮还在跑时的状态文案。镜像节点在库里
   * 恒为 done（内容来自 jsonl 快照），真实运行态来自 hook / 窗格状态，由线性视图算好
   * 传进来：有值 = 按进行中渲染（底部 RunLine、不出「暂无文本回复」和 tok/s）。
   */
  mirrorRun?: string | null;
};

export const TurnCard = memo(function TurnCard({
  node,
  readOnly = false,
  index,
  isActive = false,
  canBranch = false,
  branchArmed = false,
  onBranch,
  canDelete = false,
  onDelete,
  mirrorRun = null,
}: TurnCardProps) {
  const jumpToParentAtAnchor = useSessionStore((s) => s.jumpToParentAtAnchor);
  const hasParent = useSessionStore((s) =>
    Boolean(node.parentId && s.nodes[node.parentId]),
  );

  const toolbar = (
    <TurnToolbar
      node={node}
      readOnly={readOnly}
      canBranch={canBranch}
      branchArmed={branchArmed}
      onBranch={onBranch}
      canDelete={canDelete}
      onDelete={onDelete}
    />
  );

  if (node.kind === "reference") {
    return (
      <>
        <ReferenceFullBody key={node.id} node={node} />
        {toolbar}
      </>
    );
  }

  return (
    <>
      {node.parentAnchor && hasParent && (
        <button
          type="button"
          onClick={() => jumpToParentAtAnchor(node.parentId!, node.id)}
          className="mb-2 -ml-1.5 inline-flex max-w-full items-center gap-1.5 min-h-6.5 px-1.5 rounded-field text-label text-fork-ink hover:bg-fork-muted transition-colors max-md:min-h-11"
          title="回到父节点的引用处（B）"
        >
          <Icon icon={GitBranch} size="sm" className="text-fork" />
          <span className="min-w-0 truncate">
            从「
            <span className="font-medium">
              {truncate(node.parentAnchor.selectedText, 60)}
            </span>
            」分叉
          </span>
          <span className="shrink-0 hidden sm:inline-flex items-center gap-1 text-ink-faint">
            · 回到引用处 <Kbd>B</Kbd>
          </span>
        </button>
      )}
      <QuestionBlock
        nodeId={node.id}
        question={node.question}
        attachments={node.attachments}
        readOnly={readOnly}
        index={index}
        isActive={isActive}
        unread={node.status === "done" && !node.readAt}
      />
      {/* One chronological timeline of everything the turn did — delegated
          work nests under the call that spawned it rather than being pulled
          out into a parallel panel. 大会话的 toolCalls 不随载荷下发，展开时
          由 ToolTimeline 自己按需拉取（折叠态用 stats 渲染）。 */}
      <div className="mt-3 empty:hidden">
        <ToolTimeline
          nodeId={node.id}
          toolCalls={node.toolCalls}
          stats={node.toolCallStats ?? null}
          live={node.status === "streaming"}
        />
      </div>
      {/* key={node.id} forces a fresh ResponseBody fiber per node: the
          imperative <mark> injection inside react-markdown's output diverges
          from React's virtual tree, so when the node prop changes in-place
          React's reconciler tries to removeChild against DOM that was
          re-parented under our marks and throws NotFoundError. Unmounting
          cleanly lets the cleanup clearMarks() run before React touches the
          DOM. */}
      <ResponseBody
        key={node.id}
        node={node}
        readOnly={readOnly}
        mirrorLive={mirrorRun !== null}
      />
      {/* A路③: when this node's run is paused on an interactive tool, render
          the answer form below the response so the user can reply in place
          and the model continues. */}
      {!readOnly && node.pendingInteraction && (
        <InteractionForm
          nodeId={node.id}
          interaction={node.pendingInteraction}
        />
      )}
      {node.status === "streaming" && <RunLine node={node} />}
      {mirrorRun !== null && node.status !== "streaming" ? (
        <RunLine node={node} label={mirrorRun} />
      ) : (
        toolbar
      )}
      {/* 引擎事件 / 权限切换是控制面板，不是对话内容：放到本轮最末一行浅色小字，
          不再以卡片形态夹在工具卡和正文之间。 */}
      <AsProjectControls nodeId={node.id} />
    </>
  );
});

// 流式状态全页只有一种写法：每轮底部一行「圆点 + 状态文案 + 计时」。
// 不再三点跳动 + 闪烁光标 + 脉冲点并存（research 根因 #4）。
// 2026-10-30 手机质感（参考 Cindy WorkingStatusText / Codex）：
//   - 文案节流：每条至少停留 RUNLINE_MIN_MS，连跑十个小工具不再闪成一片；
//   - 换文案：旧字向下 3px 淡出、新字从下方 3px 升起（globals.css .status-text-*）；
//   - 「在干活」的文案挂文字微光（.shimmer-text），取代这里圆点的 animate-pulse；
//     等你回答 / 批准不是「在干活」，不挂微光。reduced-motion 全部降级为静态。
const RUNLINE_MIN_MS = 1000;
const RUNLINE_SWAP_MS = 150;

function RunLine({ node, label: override }: { node: ChatNode; label?: string }) {
  const elapsed = useElapsed(node.createdAt ?? null, true);
  const runningTool = [...node.toolCalls]
    .reverse()
    .find((c) => c.status === "running");
  const waiting = !override && Boolean(node.pendingInteraction);
  const label = override ?? (node.pendingInteraction
    ? node.pendingInteraction.toolName === "AskUserQuestion"
      ? "等待你回答"
      : "等待你批准"
    : runningTool
      ? `正在运行 ${toolTitle(runningTool)}`
      : "正在生成");
  const shown = useThrottledStatus(label, RUNLINE_MIN_MS);
  return (
    <div
      data-turn-runline=""
      role="status"
      className="mt-3 flex items-center gap-2 text-ui text-ink-muted"
    >
      <StatusDot tone={waiting ? "warn" : "accent"} />
      {/* 新旧两条叠在同一格里交接；读屏只读当前那条 */}
      <span className="grid min-w-0">
        {shown.prev !== null && (
          <span
            key={`out-${shown.n}`}
            aria-hidden
            className="status-text-out col-start-1 row-start-1 min-w-0 truncate"
          >
            {shown.prev}
          </span>
        )}
        {/* 入场动画和微光都是 animation，分挂两层，免得互相覆盖 */}
        <span
          key={`in-${shown.n}`}
          className={`col-start-1 row-start-1 flex min-w-0 ${shown.n > 0 ? "status-text-in" : ""}`}
        >
          <span
            data-turn-runline-label=""
            className={`min-w-0 truncate ${waiting ? "" : "shimmer-text"}`}
          >
            {shown.text}
          </span>
        </span>
      </span>
      {elapsed !== null && (
        <span className="shrink-0 font-mono text-label tabular-nums text-ink-faint">
          {formatDuration(elapsed)}
        </span>
      )}
    </div>
  );
}

// 状态文案节流：上一条显示满 minMs 才换；期间来了好几条只换成最新那条。
// n = 第几次切换（0 = 首帧，不播入场）；prev = 正在淡出的旧文案，交接完清掉。
function useThrottledStatus(label: string, minMs: number) {
  const [state, setState] = useState(() => ({
    text: label,
    prev: null as string | null,
    n: 0,
    at: Date.now(),
  }));
  const { text, at, n } = state;
  useEffect(() => {
    if (label === text) return;
    const wait = Math.max(0, minMs - (Date.now() - at));
    const t = window.setTimeout(() => {
      setState((s) => ({ text: label, prev: s.text, n: s.n + 1, at: Date.now() }));
    }, wait);
    return () => window.clearTimeout(t);
  }, [label, text, at, minMs]);
  useEffect(() => {
    if (n === 0) return;
    const t = window.setTimeout(() => setState((s) => ({ ...s, prev: null })), RUNLINE_SWAP_MS);
    return () => window.clearTimeout(t);
  }, [n]);
  return state;
}

// 思考读秒：进行中整秒跳（「思考中 12s」），结束后一位小数（「已思考 3.2s」）。
function formatThinkSeconds(ms: number, done: boolean): string {
  const s = ms / 1000;
  if (s >= 60) return formatDuration(ms).replace(/\s/g, "");
  return done ? `${s.toFixed(1)}s` : `${Math.floor(s)}s`;
}

// 每轮底部的轻工具栏：桌面 hover / 聚焦才浮出（触屏常显），meta 一行弱化，
// token 明细进 Tooltip。流式中不显示（那时底部是 RunLine）。
function TurnToolbar({
  node,
  readOnly,
  canBranch,
  branchArmed,
  onBranch,
  canDelete,
  onDelete,
}: {
  node: ChatNode;
  readOnly: boolean;
  canBranch: boolean;
  branchArmed: boolean;
  onBranch?: (nodeId: string) => void;
  canDelete: boolean;
  onDelete?: (nodeId: string) => void;
}) {
  const markNodeRead = useSessionStore((s) => s.markNodeRead);
  const markNodeUnread = useSessionStore((s) => s.markNodeUnread);
  if (node.status === "streaming") return null;
  const done = node.status === "done";
  const hasResponse = node.kind !== "reference" && Boolean(node.response);
  const showBranch = canBranch && !!onBranch;
  const showDelete = canDelete && !!onDelete;
  if (!done && !showBranch && !showDelete) return null;

  return (
    <div
      data-turn-toolbar=""
      className="mt-2 -ml-1.5 flex min-h-7 flex-wrap items-center gap-0.5 transition-opacity duration-100 md:pointer-fine:opacity-40 md:pointer-fine:group-hover/turn:opacity-100 md:pointer-fine:focus-within:opacity-100"
    >
      {hasResponse && <CopyIconButton text={node.response} />}
      {showBranch && (
        <IconButton
          size="sm"
          label={branchArmed ? "正在从此节点分叉" : "从此节点分叉提问"}
          data-mobile-target="node-branch"
          aria-pressed={branchArmed}
          onClick={() => onBranch!(node.id)}
        >
          <Icon icon={GitBranch} size="sm" className={branchArmed ? "text-fork" : undefined} />
        </IconButton>
      )}
      {done && <BookmarkButton node={node} />}
      {done && (
        <IconButton
          size="sm"
          label={node.readAt ? "标为未读" : "标为已读"}
          data-mobile-target="node-read-toggle"
          onClick={() =>
            node.readAt
              ? void markNodeUnread(node.id)
              : void markNodeRead(node.id)
          }
        >
          <Icon icon={node.readAt ? CircleDot : CircleCheck} size="sm" />
        </IconButton>
      )}
      {done && hasResponse && (
        <div className="hidden md:contents">
          {!readOnly && (
            <RegenerateVariantButton nodeId={node.id} question={node.question} />
          )}
          {!readOnly && <CliResumeButton nodeId={node.id} />}
          <CardImageButton
            title={node.topicLabel ?? node.question}
            // 分享卡只带最终答复 —— 过程叙述在卡片图语境里是噪音。
            content={finalResponseText(node)}
          />
        </div>
      )}
      {done && node.kind !== "reference" && (
        <TurnStatsMeta
          tokenCount={node.tokenCount}
          durationMs={node.durationMs}
          createdAt={node.createdAt}
          toolCalls={node.toolCalls}
          isStreaming={false}
          className="ml-2 max-md:hidden"
        />
      )}
      <span className="flex-1" />
      {showDelete && (
        <IconButton
          size="sm"
          tone="danger"
          label="删除节点（含子树）"
          data-mobile-target="node-delete"
          onClick={() => onDelete!(node.id)}
        >
          <Icon icon={Trash2} size="sm" />
        </IconButton>
      )}
      {done && hasResponse && <MobileResponseActions node={node} readOnly={readOnly} />}
    </div>
  );
}

function CopyIconButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <IconButton
      size="sm"
      label="复制全文"
      title={
        state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制全文（markdown 源）"
      }
      className="max-md:hidden"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await copyText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        window.setTimeout(() => setState("idle"), 1500);
      }}
    >
      <Icon icon={state === "copied" ? Check : Copy} size="sm" />
    </IconButton>
  );
}

// D5: regenerate the same question as a NEW sibling (a second "version"),
// rather than overwriting in place like retry. The branch entries in the
// thread then let the user compare the variants side by side.
function RegenerateVariantButton({
  nodeId,
  question,
  menu = false,
  onDone,
}: {
  nodeId: string;
  question: string;
  menu?: boolean;
  /** 菜单形态：点完收起所在的 action sheet */
  onDone?: () => void;
}) {
  const editNode = useSessionStore((s) => s.editNode);
  const label = "用相同问题再答一版（新建兄弟节点，可在分支列表对比）";
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    editNode(nodeId, question);
    onDone?.();
  };
  if (menu) {
    return (
      <Button
        type="button"
        data-mobile-target="response-regenerate"
        variant="secondary"
        size="sm"
        onClick={onClick}
        title={label}
        className="nodrag"
      >
        <Icon icon={RefreshCw} size="sm" />
        再答一版
      </Button>
    );
  }
  return (
    <IconButton
      size="sm"
      label={label}
      data-mobile-target="response-regenerate"
      onClick={onClick}
      className="nodrag"
    >
      <Icon icon={RefreshCw} size="sm" />
    </IconButton>
  );
}

function MobileResponseActions({
  node,
  readOnly,
}: {
  node: ChatNode;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);

  // 手机「更多」走贴底 action sheet（点 scrim / 取消 / Esc 关）。sheet 在 z-50：
  // 卡片图预览的 Modal（z-60）从这里打开时盖在上面，关掉回到 sheet。
  return (
    <div
      data-mobile-response-actions
      className="relative flex items-center gap-1 md:hidden"
    >
      <CopyButton
        text={node.response}
        label="复制全文"
        className="nodrag min-h-11 min-w-11 rounded-field px-2.5 text-ui text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
      />
      <button
        type="button"
        data-mobile-target="response-more"
        aria-label="更多回答操作"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-field text-ink-muted hover:bg-surface-hover"
      >
        <Icon icon={Ellipsis} />
      </button>
      <ActionSheet open={open} onClose={() => setOpen(false)} label="回答操作">
        <div
          data-mobile-response-menu
          className="flex flex-col gap-2 p-3 [&>button]:min-h-12 [&>button]:w-full [&>button]:justify-start"
        >
          <BookmarkButton
            node={node}
            mobileMenu
            onToggle={() => setOpen(false)}
          />
          {!readOnly && <CliResumeButton nodeId={node.id} />}
          {!readOnly && (
            <RegenerateVariantButton
              nodeId={node.id}
              question={node.question}
              menu
              onDone={() => setOpen(false)}
            />
          )}
          <CardImageButton
            title={node.topicLabel ?? node.question}
            content={finalResponseText(node)}
          />
        </div>
      </ActionSheet>
    </div>
  );
}

function QuestionBlock({
  nodeId,
  question,
  attachments,
  readOnly,
  index,
  isActive,
  unread,
}: {
  nodeId: string;
  question: string;
  attachments: NodeAttachment[];
  readOnly: boolean;
  index?: number | string;
  isActive: boolean;
  unread: boolean;
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
      <div className="rounded-card border border-accent-line bg-surface p-2.5">
        <textarea
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (isSendCombo(e, sendKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          rows={3}
          className="w-full resize-none px-1.5 py-1 bg-transparent text-reading text-ink-strong outline-none leading-relaxed"
        />
        <div className="flex items-center justify-between gap-2 mt-1.5">
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
              <Icon icon={RotateCcw} size="sm" />
              重问
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const questionText = parseNodeRefs(question).text;
  return (
    <div
      data-turn-question=""
      className="group/q relative w-full max-w-full min-w-0 rounded-card bg-surface-muted pl-4.5 pr-10 py-2.5"
    >
      {/* 提问的主色竖条：和助手正文一眼分开（强调色点缀，2026-09-29）。 */}
      <span aria-hidden className="absolute left-1.5 top-2.5 bottom-2.5 w-0.75 rounded-full bg-accent" />
      {/* 左侧槽位：未读点常显；序号 hover / 当前锚点时显示（手机端没有槽位，只留点）。 */}
      <span className="absolute right-full top-3 mr-2 flex items-center gap-1.5 whitespace-nowrap">
        {index !== undefined && (
          <span
            className={`font-mono text-nano tabular-nums max-md:hidden transition-opacity ${
              isActive
                ? "text-accent-ink opacity-100"
                : "text-ink-faint opacity-0 group-hover/turn:opacity-100"
            }`}
          >
            #{index}
          </span>
        )}
        {unread && <StatusDot tone="unread" label="未读" />}
      </span>
      <div className="text-reading text-ink-strong leading-relaxed whitespace-pre-wrap break-words break-all [overflow-wrap:anywhere] min-w-0">
        {questionText}
      </div>
      {/* `@` 引用其他会话 / 节点：正文里的标记剥掉，渲染成可点击的引用卡 */}
      <NodeRefCards question={question} />
      {attachments.length > 0 && (
        <div className="mt-2">
          <AttachmentPreview attachments={attachments} readOnly />
        </div>
      )}
      {!readOnly && (
        <IconButton
          size="sm"
          label="编辑问题"
          title="编辑问题（会新建一个分支重问）"
          onClick={() => {
            setText(question);
            setEditing(true);
          }}
          className="absolute right-1.5 top-1.5 md:pointer-fine:opacity-0 md:pointer-fine:group-hover/q:opacity-100 md:pointer-fine:focus-visible:opacity-100"
        >
          <Icon icon={Pencil} size="sm" />
        </IconButton>
      )}
    </div>
  );
}

// Dim auto-scrolling viewport for the live thinking stream. Pinned to the
// bottom as text grows (thinking is transient status, not reading material —
// following the tail beats preserving scroll position).
function ThinkingScroll({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div
      ref={ref}
      className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-ui leading-relaxed text-ink-muted"
    >
      {text}
    </div>
  );
}

// 思考块：还没有正文时展开（看它在想什么），正文一开始就自动折叠；用户点过
// 就尊重用户（userOpen 钉住）。回合结束整块消失（思考流不落库）。
//
// 读秒（参考 Codex / Cindy）：思考进行中「思考中 12s」实时跳，想完（开始作答 /
// 去跑工具）定格为「已思考 3.2s」。起点 = 第一段思考流到达（本组件挂载），
// 终点 = answering 翻真的那一帧；又回头想（answering 翻回假）就接着从起点数。
function ThinkingBlock({ text, answering }: { text: string; answering: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !answering;
  const [startedAt] = useState(() => Date.now());
  const [endedAt, setEndedAt] = useState<number | null>(null);
  useEffect(() => {
    // 回调里 setState（不在 effect 体内同步写）；差一帧对读秒无感。
    const id = requestAnimationFrame(() => setEndedAt(answering ? Date.now() : null));
    return () => cancelAnimationFrame(id);
  }, [answering]);
  const live = useElapsed(startedAt, !answering);
  const done = answering && endedAt !== null;
  const ms = done ? endedAt - startedAt : (live ?? 0);
  return (
    <div className="mb-3" data-turn-thinking="">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        title={`思考过程 ${text.length} 字`}
        className="-ml-1 inline-flex items-center gap-1.5 min-h-6.5 px-1 rounded-field text-ui text-ink-faint hover:bg-surface-hover hover:text-ink-muted transition-colors max-md:min-h-11"
      >
        <Icon
          icon={ChevronRight}
          size="sm"
          className={`ui-collapse-chevron ${open ? "rotate-90" : ""}`}
        />
        <Icon icon={Brain} size="sm" />
        <span className={answering ? undefined : "shimmer-text"}>
          {answering ? "已思考" : "思考中"}
        </span>
        <span data-turn-thinking-time="" className="font-mono text-label tabular-nums">
          {formatThinkSeconds(ms, done)}
        </span>
      </button>
      <Collapse open={open} className="ml-2">
        {/* 外边距放在被裁切的内层里，收起时一起压到 0 */}
        <div className="mt-1.5 pl-3.5 border-l border-line-strong">
          <ThinkingScroll text={text} />
        </div>
      </Collapse>
    </div>
  );
}

// S88：@提及的一次性外援标记。刻意只说「由 @提及的 Agent 作答」而不查名字 ——
// 节点只存 agent id，为一枚 chip 去 fetch 每个节点的 agent 名不值当，而且被删掉的
// agent 会让历史节点渲染出一片空白。语义（这轮不是主线人格答的）已经传达到了。
function MentionChip() {
  return (
    <div className="mb-2 inline-flex items-center gap-1.5 min-h-6 px-2 rounded-field border border-line text-label text-ink-muted">
      <Icon icon={AtSign} size="sm" className="text-ink-faint" />
      <span>这一轮由 @提及的 Agent 单独作答（主线人格不变）</span>
    </div>
  );
}

function ResponseBody({
  node,
  readOnly,
  mirrorLive = false,
}: {
  node: ChatNode;
  readOnly: boolean;
  /** 镜像会话本轮仍在跑：空 response 只是还没写到，不出「暂无输出」。 */
  mirrorLive?: boolean;
}) {
  const retryNode = useSessionStore((s) => s.retryNode);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isStreaming = node.status === "streaming";
  const isError = node.status === "error";
  // 错误降级（见 SupersededErrorNotice）：有子节点 = 用户已续跑/绕过，
  // 红横幅降级为安静备注。boolean selector，仅在真假翻转时触发重渲染。
  const hasChildren = useSessionStore((s) => {
    for (const k in s.nodes) {
      if (s.nodes[k].parentId === node.id) return true;
    }
    return false;
  });
  // P1: 视口外的 done 卡片先挂纯文本占位，滚到 800px 内再升级完整
  // markdown（useNearViewport），长会话首次切换也不必等全部卡片跑完
  // parse+highlight+katex。锚点跳转目标强制立即渲染——marks 的滚动闪烁
  // 依赖 markdown DOM。
  const isAnchorTarget = useSessionStore(
    (s) => s.pendingScrollAnchor?.nodeId === node.id,
  );
  const near = useNearViewport(bodyRef, { force: isAnchorTarget });

  const { onMarkClick } = useMarkdownBodyMarks({
    bodyRef,
    nodeId: node.id,
    contentVersion: node.response,
    suspended: isStreaming || !near,
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
      className="md-body mt-3 text-reading text-ink leading-relaxed w-full max-w-full min-w-0"
    >
      {/* S88 @提及：这一轮是外援答的，标出来 —— 否则读者会以为主线人格变了。
          会话级人设（agentScope==='session'）刻意不挂 chip：每张卡都挂一枚是
          噪音，那个显示在 Header 的 ModeBadge 上。 */}
      {node.agentScope === "mention" && <MentionChip />}
      {isStreaming && liveThinking && (
        <ThinkingBlock
          text={liveThinking}
          // 想完去跑工具了也算「想完」：否则 Bash 跑一分钟，这里一直挂「思考中…」。
          answering={
            Boolean(liveText) || node.toolCalls.some((c) => c.status === "running")
          }
        />
      )}
      {isStreaming ? (
        liveText ? (
          // 告诉代码块「还在写」：Mermaid 等源码静止再渲染、半截不报错
          <MarkdownStreamingContext.Provider value>
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_STREAMING_REHYPE_PLUGINS}
              components={MD_COMPONENTS}
              urlTransform={MD_URL_TRANSFORM}
            >
              {liveText}
            </ReactMarkdown>
          </MarkdownStreamingContext.Provider>
        ) : null
      ) : node.response ? (
        near ? (
          <>
            <SegmentedResponse node={node} />
            <GeneratedFilesBar node={node} />
          </>
        ) : (
          // 占位：成本约等于一个 text node。aria-hidden 避免屏幕阅读器念
          // 原始 markdown 符号；升级后真实内容自然可读。
          <div className="whitespace-pre-wrap break-words" aria-hidden>
            {node.response}
          </div>
        )
      ) : mirrorLive ? null : (
        <EmptyResponseNotice
          hasToolCalls={
            node.toolCalls.length > 0 || (node.toolCallStats?.total ?? 0) > 0
          }
        />
      )}
      {isError && hasChildren && (
        <SupersededErrorNotice
          nodeId={node.id}
          errorMessage={node.errorMessage}
        />
      )}
      {!readOnly &&
        isError &&
        !hasChildren &&
        (node.errorMessage === "aborted" ? (
          <div className="not-prose mt-3 flex items-center gap-2 text-ui text-ink-muted">
            <Icon icon={TriangleAlert} size="sm" className="text-ink-faint" />
            <span className="flex-1">已停止生成</span>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => retryNode(node.id)}
            >
              <Icon icon={RotateCcw} size="sm" />
              重新发送
            </Button>
          </div>
        ) : (
          <ErrorCallout
            className="mt-3"
            compact
            error={node.errorMessage}
            title="本轮出错"
            hint={node.errorMessage ?? undefined}
            onRetry={() => retryNode(node.id)}
            retryLabel="重新生成"
            action={
              isAuthErrorMessage(node.errorMessage) ? (
                <Button asChild variant="link" size="sm">
                  <a href="/settings/models">像是 CLI 授权问题，查看授权状态</a>
                </Button>
              ) : undefined
            }
          />
        ))}
    </div>
  );
}

// Agent 长任务的 done 态正文分层（见 lib/types.ts:ChatNode.finalStart）：
// 工具调用/思考之间的过程叙述折叠成一块弱化区，最终答复才是正文。没有
// finalStart（纯 chat、旧数据、整段即答复）时与原来逐字节一致。
// 过程段 trimEnd：段落分隔的 "\n\n" 尾巴不值得让 markdown 渲染个空段。
function splitResponse(node: ChatNode): { preamble: string; final: string } {
  const s = node.finalStart ?? 0;
  if (s <= 0 || s >= node.response.length) {
    return { preamble: "", final: node.response };
  }
  return {
    preamble: node.response.slice(0, s).trimEnd(),
    final: node.response.slice(s),
  };
}

function finalResponseText(node: ChatNode): string {
  return splitResponse(node).final;
}

function SegmentedResponse({ node }: { node: ChatNode }) {
  const { preamble, final } = splitResponse(node);
  return (
    <>
      {preamble && (
        // <details> 不受控，与思考折叠同一心智模型。展开后弱化字号/墨色 ——
        // 过程叙述是「它当时在干嘛」，不该和答复争阅读权重。
        <details className="group/pre mb-3">
          <summary className="-ml-1 inline-flex cursor-pointer select-none items-center gap-1.5 min-h-6.5 px-1 rounded-field text-ui text-ink-faint hover:bg-surface-hover hover:text-ink-muted list-none [&::-webkit-details-marker]:hidden">
            <Icon
              icon={ChevronRight}
              size="sm"
              className="transition-transform motion-reduce:transition-none group-open/pre:rotate-90"
            />
            过程叙述（{preamble.length} 字）
          </summary>
          <div className="mt-1.5 ml-2 pl-3.5 border-l border-line-strong text-ui text-ink-muted [&_.md-body]:text-ui">
            <MarkdownBody cacheKey={`${node.id}:pre`} content={preamble} />
          </div>
        </details>
      )}
      <MarkdownBody cacheKey={node.id} content={final} />
    </>
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
  const isAnchorTarget = useSessionStore(
    (s) => s.pendingScrollAnchor?.nodeId === node.id,
  );
  const near = useNearViewport(bodyRef, { force: isAnchorTarget });
  const { onMarkClick } = useMarkdownBodyMarks({
    bodyRef,
    nodeId: node.id,
    contentVersion: ref?.contentMd ?? "",
    suspended: isStreaming || !near,
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
      <div className="mb-3 px-3.5 py-2.5 rounded-card border border-line bg-surface-muted text-ui flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 inline-flex text-ink-faint" aria-hidden>
          {isStreaming ? (
            <Spinner size="sm" label={null} />
          ) : (
            <Icon icon={ref.sourceType === "paste" ? FileText : Link2} size="md" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-label text-ink-faint">参考材料</div>
          <div className="font-medium text-ink-strong truncate">
            {node.topicLabel ?? "参考材料"}
          </div>
          {ref.sourceUri && (
            <a
              href={ref.sourceUri}
              target="_blank"
              rel="noreferrer"
              className="block mt-0.5 truncate font-mono text-label text-ink-muted underline-offset-2 hover:underline hover:text-accent-ink"
              onClick={(e) => e.stopPropagation()}
            >
              {ref.sourceUri}
            </a>
          )}
          {ref.meta.fetchError && !isStreaming && (
            <div className="mt-1 flex items-center gap-1.5 text-danger-ink text-ui">
              <Icon icon={TriangleAlert} size="sm" />
              抓取失败：{ref.meta.fetchError}
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
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              loading={refreshing}
              className="shrink-0"
              title="重新抓取"
            >
              {!refreshing && <Icon icon={RefreshCw} size="sm" />}
              刷新
            </Button>
          )
        )}
      </div>

      {isStreaming && (
        <div className="mb-3 text-ui text-ink-muted">
          <div className="flex items-center gap-2">
            <StatusDot tone="live" />
            <span className="font-medium">{fetchProgress || "启动中…"}</span>
          </div>
          <div className="mt-1 pl-3.5 text-label text-ink-faint leading-relaxed">
            正在挑选并运行合适的 skill 抓取这个链接。飞书 / YouTube / B 站
            通常 5–60 秒，PDF / 大型文档可能更久，可以随时停止。
          </div>
        </div>
      )}

      <div
        ref={bodyRef}
        data-chat-node-id={node.id}
        onClick={onMarkClick}
        className="md-body text-reading text-ink leading-relaxed w-full max-w-full min-w-0"
      >
        {ref.contentMd ? (
          near ? (
            <MarkdownBody cacheKey={`ref:${node.id}`} content={ref.contentMd} />
          ) : (
            <div className="whitespace-pre-wrap break-words" aria-hidden>
              {ref.contentMd}
            </div>
          )
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
