"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Code,
  FileCode,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  WrapText,
  X,
} from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Modal,
  SegmentedControl,
  Skeleton,
  SkeletonText,
  cn,
  toast,
} from "@/components/ui";
import { CopyButton } from "@/components/CopyButton";
import { DiffFileView, type NewComment } from "@/components/diff-review/DiffFileView";
import { FullFileView } from "@/components/diff-review/FullFileView";
import type { ChangedFile } from "@/app/api/workspaces/git-diff/route";
import { fileBaseName, groupFilesByDir, parseUnifiedDiff, type DiffFile } from "@/lib/unified-diff";
import {
  commentAnchor,
  commentLocation,
  formatReviewMessage,
  lastChangedTurn,
  snippetAt,
  sortComments,
  toRepoRelative,
  turnChangedPaths,
  type ReviewComment,
} from "@/lib/diff-review";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useGesturesEnabled, useSwipe } from "@/hooks/useSwipe";
import { useSessionStore } from "@/stores/sessionStore";
import { useDiffReviewStore, type ReviewScope } from "@/stores/diffReviewStore";
import { useComposerInsertStore } from "@/stores/composerInsertStore";

// 工作区变更审阅（参考 Codex 手机端的分层审阅）：
//   文件列表层（状态 / +- / 可按目录分组）→ 单文件 diff 层（折行、hunk 折叠、点行评论）
//   → 完整文件层；另有评论草稿层。手机上是全屏 sheet（返回按钮 + 右滑返回），桌面是弹窗。
// 过滤：全部（相对 HEAD）/ 未暂存 / 已暂存 / 相对默认分支 / 仅上一轮（会话轮次里
// Write/Edit 记录的文件集合）。评论「发送给 agent」= 整理成一条消息放进该会话输入框
// 草稿，由用户确认后发送。
//
// 入口：侧栏工作区角标（workspaceId）；会话内顶栏菜单与「本轮生成」文件条（sessionId，
// 经 DiffReviewHost 挂载）。

export type WorkspaceDiffModalProps = {
  workspaceId?: string | null;
  sessionId?: string | null;
  workspaceName?: string;
  workspacePath?: string;
  initialScope?: ReviewScope;
  /** scope=turn 时指定是哪一轮；不传 = 最近一轮有文件改动的 */
  turnNodeId?: string;
  onClose: () => void;
  onStartSession?: (path: string) => void;
};

type DiffData = {
  workspaceId: string | null;
  sessionId: string | null;
  name: string;
  path: string;
  root: string | null;
  prefix: string;
  isGit: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  untracked: string[];
  diff: string;
  truncated: boolean;
  baseRef: string | null;
  baseError?: string | null;
  dirtyCount: number;
};

type Layer = { kind: "list" } | { kind: "file"; path: string } | { kind: "full"; path: string } | { kind: "comments" };

type FileItem = DiffFile & { untracked: boolean };

const EMPTY_COMMENTS: ReviewComment[] = [];
const EMPTY_SET: ReadonlySet<number> = new Set();

const SCOPE_OPTIONS: { value: ReviewScope; label: string; title: string }[] = [
  { value: "all", label: "全部", title: "全部未提交改动（相对 HEAD，含未跟踪文件）" },
  { value: "unstaged", label: "未暂存", title: "工作区里还没 git add 的改动" },
  { value: "staged", label: "已暂存", title: "已 git add、待提交的改动" },
  { value: "base", label: "相对主干", title: "相对默认分支（merge-base）的全部改动" },
  { value: "turn", label: "上一轮", title: "只看会话上一轮里 agent 写 / 改过的文件" },
];

function statusBadge(status: DiffFile["status"], untracked: boolean) {
  const map: Record<DiffFile["status"], [string, string]> = {
    M: ["bg-warn-muted text-warn-ink", "M"],
    A: ["bg-positive-muted text-positive-ink", "A"],
    D: ["bg-danger-muted text-danger-ink", "D"],
    R: ["bg-accent-muted text-accent-ink", "R"],
  };
  const [color, text] = untracked ? ["bg-surface-muted text-ink-faint", "U"] : map[status];
  const label = untracked ? "未跟踪" : { M: "修改", A: "新增", D: "删除", R: "重命名" }[status];
  return (
    <span
      title={label}
      aria-label={label}
      className={cn("inline-flex w-5 shrink-0 justify-center rounded-sm py-0.5 font-mono text-nano font-semibold", color)}
    >
      {text}
    </span>
  );
}

function newCommentId(): string {
  // crypto.randomUUID 只在安全上下文可用；手机走局域网 http 时没有
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function WorkspaceDiffModal({
  workspaceId,
  sessionId,
  workspaceName,
  workspacePath,
  initialScope = "all",
  turnNodeId,
  onClose,
  onStartSession,
}: WorkspaceDiffModalProps) {
  const query = workspaceId
    ? `workspaceId=${encodeURIComponent(workspaceId)}`
    : sessionId
      ? `sessionId=${encodeURIComponent(sessionId)}`
      : null;

  const isMobile = useIsMobile();
  const gestures = useGesturesEnabled();
  const [scope, setScope] = useState<ReviewScope>(initialScope);
  const [reloadKey, setReloadKey] = useState(0);
  const [layers, setLayers] = useState<Layer[]>([{ kind: "list" }]);
  const [grouped, setGrouped] = useState(false);
  const [wrapPref, setWrapPref] = useState<boolean | null>(null);
  // 手机默认折行（长行不撑开横向），桌面默认不折行
  const wrap = wrapPref ?? isMobile !== false;
  const [collapsedByFile, setCollapsedByFile] = useState<Record<string, ReadonlySet<number>>>({});

  // ── 取数：以「请求 key」记结果，loading = 结果不是当前 key 的（effect 里不同步 setState）
  const fetchScope = scope === "turn" ? "all" : scope;
  const fetchKey = query ? `${query}&scope=${fetchScope}#${reloadKey}` : null;
  const [result, setResult] = useState<{ key: string; data?: DiffData; error?: unknown } | null>(null);
  useEffect(() => {
    if (!fetchKey) return;
    const ctrl = new AbortController();
    fetch(`/api/workspaces/git-diff?${query}&scope=${fetchScope}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((res) => setResult(res.error ? { key: fetchKey, error: res.error } : { key: fetchKey, data: res as DiffData }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setResult({ key: fetchKey, error: e });
      });
    return () => ctrl.abort();
  }, [fetchKey, query, fetchScope]);
  const loading = result?.key !== fetchKey;
  // 切过滤时先保留上一份数据（只是灰掉），避免整页闪骨架
  const data = result?.data ?? null;
  const error = loading ? null : result?.error;

  // ── 目标会话（发送评论 / 仅上一轮都要它）
  const storeSession = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const targetSessionId =
    sessionId ??
    (storeSession &&
    ((!!workspaceId && storeSession.workspaceId === workspaceId) || (!!data?.path && storeSession.workspacePath === data.path))
      ? storeSession.id
      : null);
  const turnAvailable = !!targetSessionId && storeSession?.id === targetSessionId;

  const turn = useMemo(() => {
    if (!turnAvailable) return null;
    if (turnNodeId && nodes[turnNodeId]) {
      const n = nodes[turnNodeId];
      return { node: n, paths: turnChangedPaths(n) };
    }
    return lastChangedTurn(nodes);
  }, [turnAvailable, turnNodeId, nodes]);

  const turnRelPaths = useMemo(() => {
    if (!turn || !data?.root) return null;
    const set = new Set<string>();
    for (const abs of turn.paths) {
      const viaRoot = toRepoRelative(abs, data.root);
      const viaCwd = toRepoRelative(abs, data.path);
      const rel = viaRoot ?? (viaCwd !== null ? data.prefix + viaCwd : null);
      if (rel) set.add(rel);
    }
    return set;
  }, [turn, data]);

  const allFiles: FileItem[] = useMemo(() => {
    if (!data?.diff) return [];
    const untracked = new Set(data.untracked ?? []);
    return parseUnifiedDiff(data.diff).map((f) => ({ ...f, untracked: untracked.has(f.path) }));
  }, [data]);

  const files = useMemo(
    () => (scope === "turn" ? (turnRelPaths ? allFiles.filter((f) => turnRelPaths.has(f.path)) : []) : allFiles),
    [scope, allFiles, turnRelPaths],
  );
  const turnUnchanged = useMemo(() => {
    if (scope !== "turn" || !turnRelPaths) return [];
    const have = new Set(files.map((f) => f.path));
    return [...turnRelPaths].filter((p) => !have.has(p));
  }, [scope, turnRelPaths, files]);

  // ── 评论草稿（按仓库根分桶）
  const bucket = data?.root ?? data?.path ?? workspacePath ?? "";
  const comments = useDiffReviewStore((s) => s.comments[bucket]) ?? EMPTY_COMMENTS;
  const addComment = useDiffReviewStore((s) => s.addComment);
  const removeComment = useDiffReviewStore((s) => s.removeComment);
  const clearComments = useDiffReviewStore((s) => s.clearComments);
  const reviewMessage = useMemo(() => formatReviewMessage(comments), [comments]);

  // ── 导航
  const layer = layers[layers.length - 1];
  const push = (l: Layer) => setLayers((ls) => [...ls, l]);
  const back = useCallback(() => setLayers((ls) => (ls.length > 1 ? ls.slice(0, -1) : ls)), []);
  const replaceTop = (l: Layer) => setLayers((ls) => [...ls.slice(0, -1), l]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useSwipe(bodyRef, {
    enabled: gestures && layers.length > 1,
    axis: "x",
    // 横滚的代码区 / 输入框里不接管
    canStart: (e) => !(e.target as Element | null)?.closest?.('[data-diff-scroll="x"], textarea, input'),
    onEnd: ({ commit }) => {
      if (commit > 0) back();
    },
  });

  // Esc：有下层先返回一层，到列表层才关闭。Modal 的 Esc 已关（closeOnEsc=false 时 Radix 会
  // 先 preventDefault，所以这里不看 defaultPrevented）
  const depth = layers.length;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      e.preventDefault();
      if (depth > 1) back();
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [depth, back, onClose]);

  const currentPath = layer.kind === "file" || layer.kind === "full" ? layer.path : null;
  const currentFile = currentPath ? (allFiles.find((f) => f.path === currentPath) ?? null) : null;
  const fileIndex = currentFile ? files.findIndex((f) => f.path === currentFile.path) : -1;

  const send = () => {
    if (!reviewMessage) return;
    if (!targetSessionId) {
      toast.error("没有找到这个工作区对应的会话", { description: "先打开该工作区的会话，或复制后手动粘贴。" });
      return;
    }
    useComposerInsertStore.getState().queueComposerInsert(targetSessionId, reviewMessage);
    clearComments(bucket);
    toast.success(`已把 ${comments.length} 条评论放进输入框`, { description: "确认内容后再发送给 agent。" });
    onClose();
  };

  const onAddComment = (file: DiffFile, c: NewComment) => {
    const hunk = file.hunks[c.hunkIndex];
    const line = hunk?.lines[c.lineIndex];
    const anchor = line ? commentAnchor(line) : null;
    if (!hunk || !anchor) return;
    addComment(bucket, {
      id: newCommentId(),
      path: file.path,
      side: anchor.side,
      line: anchor.line,
      snippet: snippetAt(hunk, c.lineIndex),
      body: c.body,
      createdAt: Date.now(),
    });
  };

  const commentCountByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) m.set(c.path, (m.get(c.path) ?? 0) + 1);
    return m;
  }, [comments]);

  if (!query) return null;

  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  const shownPath = data?.path || workspacePath || "";

  // ── 顶栏
  const title =
    layer.kind === "list"
      ? data?.name || workspaceName || "工作区变更"
      : layer.kind === "comments"
        ? `评论草稿（${comments.length}）`
        : fileBaseName(layer.path);
  const subtitle =
    layer.kind === "file" || layer.kind === "full"
      ? `${layer.kind === "full" ? "完整文件 · " : ""}${layer.path.includes("/") ? layer.path.slice(0, layer.path.lastIndexOf("/")) : "根目录"}`
      : null;

  const header = (
    <div
      className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-2 md:px-3"
      style={isMobile ? { paddingTop: "calc(0.5rem + var(--safe-top))" } : undefined}
    >
      {layers.length > 1 && (
        <IconButton label="返回" onClick={back}>
          <Icon icon={ChevronLeft} />
        </IconButton>
      )}
      <div className={cn("flex min-w-0 flex-1 flex-col", layers.length === 1 && "pl-1")}>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-ui font-semibold text-ink-strong" title={currentPath ?? undefined}>
            {title}
          </h2>
          {layer.kind === "list" && data?.branch && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 font-mono text-label text-ink-muted max-md:hidden">
              <Icon icon={GitBranch} size="sm" />
              {data.branch}
            </span>
          )}
          {layer.kind === "list" && data && (data.ahead > 0 || data.behind > 0) && (
            <span className="shrink-0 text-label tabular-nums text-ink-faint max-md:hidden" title={`领先上游 ${data.ahead} 个提交，落后 ${data.behind} 个`}>
              {data.ahead > 0 && `领先 ${data.ahead} `}
              {data.behind > 0 && `落后 ${data.behind}`}
            </span>
          )}
        </div>
        {subtitle && <span className="truncate font-mono text-nano text-ink-faint">{subtitle}</span>}
        {layer.kind === "list" && data?.branch && (
          <span className="truncate font-mono text-nano text-ink-faint md:hidden">{data.branch}</span>
        )}
      </div>
      {layer.kind !== "comments" && comments.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => push({ kind: "comments" })} aria-label={`查看 ${comments.length} 条评论草稿`}>
          <Icon icon={MessageSquare} size="sm" />
          <span className="tabular-nums">{comments.length}</span>
        </Button>
      )}
      <IconButton label="关闭" onClick={onClose}>
        <Icon icon={X} />
      </IconButton>
    </div>
  );

  // ── 各层工具条
  let toolbar: ReactNode = null;
  if (layer.kind === "list" && data?.isGit) {
    toolbar = (
      <div className="flex shrink-0 flex-col gap-2 border-b border-line-faint bg-surface-muted px-3 py-2">
        <div className="-mx-3 overflow-x-auto px-3">
          <SegmentedControl
            aria-label="改动范围"
            size="sm"
            value={scope}
            onValueChange={(v) => {
              setScope(v);
              setLayers([{ kind: "list" }]);
            }}
            options={SCOPE_OPTIONS.map((o) => ({
              ...o,
              label: o.value === "base" && data.baseRef ? `相对 ${data.baseRef.replace(/^origin\//, "")}` : o.label,
              disabled: o.value === "turn" && !turnAvailable,
              title: o.value === "turn" && !turnAvailable ? "在会话里打开审阅才能按轮次过滤" : o.title,
            }))}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2 text-label">
          <span className="font-medium text-ink-strong">{files.length} 个文件</span>
          <span className="font-mono tabular-nums">
            <span className="text-positive-ink">+{totalAdd}</span> <span className="text-danger-ink">−{totalDel}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={grouped}
              onClick={() => setGrouped((g) => !g)}
              className={cn(grouped && "bg-surface-hover text-ink")}
            >
              <Icon icon={FolderTree} size="sm" />
              按目录
            </Button>
            {shownPath && (
              <Button variant="ghost" size="sm" className="max-md:hidden" onClick={() => (window.location.href = `vscode://file/${encodeURI(shownPath)}`)} title="在本地 VS Code 中打开该工作区">
                <Icon icon={Code} size="sm" />
                VS Code
              </Button>
            )}
            {onStartSession && shownPath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onStartSession(shownPath);
                  onClose();
                }}
                title="在此工作区开启新会话"
              >
                <Icon icon={Plus} size="sm" />
                新会话
              </Button>
            )}
          </div>
        </div>
        {scope === "turn" && turn && (
          <p className="truncate text-nano text-ink-faint" title={turn.node.question}>
            上一轮：{(turn.node.topicLabel ?? turn.node.question).replace(/\s+/g, " ").slice(0, 60)} · 显示这些文件当前相对 HEAD 的改动
          </p>
        )}
        {scope === "base" && data.baseError && <p className="text-nano text-warn-ink">{data.baseError}</p>}
      </div>
    );
  } else if ((layer.kind === "file" || layer.kind === "full") && currentFile) {
    const collapsed = collapsedByFile[currentFile.path] ?? EMPTY_SET;
    toolbar = (
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line-faint bg-surface-muted px-2 py-1.5">
        {statusBadge(currentFile.status, currentFile.untracked)}
        <span className="mx-1 shrink-0 font-mono text-label tabular-nums">
          <span className="text-positive-ink">+{currentFile.additions}</span> <span className="text-danger-ink">−{currentFile.deletions}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={wrap}
            onClick={() => setWrapPref(!wrap)}
            className={cn(wrap && "bg-surface-hover text-ink")}
          >
            <Icon icon={WrapText} size="sm" />
            折行
          </Button>
          {layer.kind === "file" && currentFile.hunks.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setCollapsedByFile((m) => ({
                  ...m,
                  [currentFile.path]: collapsed.size > 0 ? EMPTY_SET : new Set(currentFile.hunks.map((_, i) => i)),
                }))
              }
            >
              <Icon icon={collapsed.size > 0 ? ChevronsUpDown : ChevronsDownUp} size="sm" />
              {collapsed.size > 0 ? "全部展开" : "全部折叠"}
            </Button>
          )}
          {layer.kind === "file" && !currentFile.binary && (
            <Button variant="ghost" size="sm" onClick={() => push({ kind: "full", path: currentFile.path })}>
              <Icon icon={FileCode} size="sm" />
              完整文件
            </Button>
          )}
          {layer.kind === "file" && files.length > 1 && fileIndex >= 0 && (
            <>
              <IconButton label="上一个文件" disabled={fileIndex <= 0} onClick={() => replaceTop({ kind: "file", path: files[fileIndex - 1].path })}>
                <Icon icon={ChevronUp} />
              </IconButton>
              <IconButton
                label="下一个文件"
                disabled={fileIndex >= files.length - 1}
                onClick={() => replaceTop({ kind: "file", path: files[fileIndex + 1].path })}
              >
                <Icon icon={ChevronDown} />
              </IconButton>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── 正文
  let body: ReactNode;
  if (!data && loading) {
    body = (
      <div className="flex flex-col gap-4" role="status" aria-label="正在读取工作区变更">
        <Skeleton className="h-4 w-40" />
        <SkeletonText lines={4} />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else if (error) {
    body = <ErrorCallout error={error} title="读取工作区变更失败" onRetry={() => setReloadKey((k) => k + 1)} />;
  } else if (!data?.isGit) {
    body = <EmptyState compact icon={GitCommitHorizontal} title="这个目录不是 Git 仓库" description="只有 Git 工作区才能查看变更。" />;
  } else if (layer.kind === "comments") {
    body =
      comments.length === 0 ? (
        <EmptyState compact icon={MessageSquare} title="还没有评论" description="在 diff 里点某一行即可写评论。" />
      ) : (
        <ul className="flex flex-col gap-3">
          {sortComments(comments).map((c) => (
            <li key={c.id} className="overflow-hidden rounded-card border border-line">
              <div className="flex items-center gap-1 bg-surface-muted pl-3 pr-1">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate py-1.5 text-left font-mono text-label text-accent-ink hover:underline max-md:min-h-11"
                  onClick={() => allFiles.some((f) => f.path === c.path) && push({ kind: "file", path: c.path })}
                >
                  {commentLocation(c)}
                </button>
                <IconButton label="删除这条评论" tone="danger" onClick={() => removeComment(bucket, c.id)}>
                  <Icon icon={Trash2} size="sm" />
                </IconButton>
              </div>
              <p className="whitespace-pre-wrap px-3 py-2 text-ui text-ink [overflow-wrap:anywhere]">{c.body}</p>
              {c.snippet && (
                <pre className="overflow-x-auto bg-(--code-bg) px-3 py-2 font-mono text-nano text-(--code-ink)" data-diff-scroll="x">
                  {c.snippet}
                </pre>
              )}
            </li>
          ))}
        </ul>
      );
  } else if (layer.kind === "file" || layer.kind === "full") {
    body = !currentFile ? (
      <EmptyState compact icon={GitCommitHorizontal} title="这个文件已不在改动列表里" description="可能已经提交或被还原。" />
    ) : layer.kind === "full" ? (
      <FullFileView key={currentFile.path} query={query} file={currentFile} wrap={wrap} />
    ) : (
      <DiffFileView
        key={currentFile.path}
        file={currentFile}
        wrap={wrap}
        collapsed={collapsedByFile[currentFile.path] ?? EMPTY_SET}
        onToggleHunk={(i) =>
          setCollapsedByFile((m) => {
            const next = new Set(m[currentFile.path] ?? EMPTY_SET);
            if (next.has(i)) next.delete(i);
            else next.add(i);
            return { ...m, [currentFile.path]: next };
          })
        }
        comments={comments.filter((c) => c.path === currentFile.path)}
        onAddComment={(c) => onAddComment(currentFile, c)}
        onRemoveComment={(id) => removeComment(bucket, id)}
      />
    );
  } else if (files.length === 0) {
    body = (
      <>
        <EmptyState
          compact
          icon={GitCommitHorizontal}
          title={scope === "turn" ? (turn ? "上一轮改过的文件当前没有未提交改动" : "会话里还没有改过文件的轮次") : "没有改动"}
          description={
            scope === "staged" ? "暂存区是空的。" : scope === "base" ? "当前分支与主干没有差异。" : scope === "turn" ? "可能已经提交，或被还原了。" : "工作区里没有修改过或未跟踪的文件。"
          }
        />
        {turnUnchanged.length > 0 && <TurnUnchangedList paths={turnUnchanged} />}
      </>
    );
  } else {
    const row = (f: FileItem) => {
      const n = commentCountByPath.get(f.path) ?? 0;
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      return (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => push({ kind: "file", path: f.path })}
            className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hover max-md:min-h-12"
          >
            {statusBadge(f.status, f.untracked)}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono text-label text-ink" title={f.path}>
                {fileBaseName(f.path)}
                {f.status === "R" && f.oldPath && <span className="text-ink-faint"> ← {fileBaseName(f.oldPath)}</span>}
              </span>
              {!grouped && dir && <span className="truncate font-mono text-nano text-ink-faint">{dir}</span>}
            </span>
            {n > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-nano text-accent-ink" aria-label={`${n} 条评论`}>
                <Icon icon={MessageSquare} size="sm" />
                {n}
              </span>
            )}
            <span className="shrink-0 font-mono text-nano tabular-nums">
              {f.binary ? (
                <span className="text-ink-faint">二进制</span>
              ) : (
                <>
                  <span className="text-positive-ink">+{f.additions}</span> <span className="text-danger-ink">−{f.deletions}</span>
                </>
              )}
            </span>
          </button>
        </li>
      );
    };
    body = (
      <div className={cn("flex flex-col gap-3 transition-opacity", loading && "opacity-60")}>
        {grouped ? (
          groupFilesByDir(files).map((g) => (
            <section key={g.dir} className="overflow-hidden rounded-card border border-line">
              <h3 className="truncate border-b border-line-faint bg-surface-muted px-3 py-1 font-mono text-nano text-ink-muted">{g.dir || "（根目录）"}</h3>
              <ul className="divide-y divide-line-faint">{g.files.map(row)}</ul>
            </section>
          ))
        ) : (
          <ul className="divide-y divide-line-faint overflow-hidden rounded-card border border-line">{files.map(row)}</ul>
        )}
        {data.truncated && <p className="text-nano text-warn-ink">改动过大，只解析了前 2MB 的 diff，后面的文件可能缺失。</p>}
        {turnUnchanged.length > 0 && <TurnUnchangedList paths={turnUnchanged} />}
      </div>
    );
  }

  // ── 底栏：有评论草稿时出现
  const footer =
    comments.length > 0 || layer.kind === "comments" ? (
      <div
        className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2"
        style={isMobile ? { paddingBottom: "calc(0.5rem + var(--safe-bottom))" } : undefined}
      >
        {layer.kind === "comments" ? (
          <>
            <Button variant="ghost" size="sm" disabled={comments.length === 0} onClick={() => clearComments(bucket)}>
              清空
            </Button>
            {reviewMessage && <CopyButton text={reviewMessage} label="复制" title="复制整理好的评论消息" />}
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => push({ kind: "comments" })}>
            <Icon icon={MessageSquare} size="sm" />
            {comments.length} 条评论草稿
          </Button>
        )}
        <Button
          variant="primary"
          className="ml-auto"
          disabled={!reviewMessage || !targetSessionId}
          onClick={send}
          title={targetSessionId ? "整理成一条消息放进输入框（不会直接发送）" : "没有打开这个工作区的会话，可在评论草稿里复制"}
        >
          <Icon icon={Send} size="sm" />
          发送给 agent
        </Button>
      </div>
    ) : null;

  return (
    <Modal
      onClose={onClose}
      size="lg"
      title="工作区变更审阅"
      closeOnEsc={false}
      panelClassName="flex flex-col md:max-h-[85vh] md:max-w-4xl max-md:fixed max-md:inset-0 max-md:max-w-none max-md:rounded-none max-md:border-0"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        {toolbar}
        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4"
          style={{
            touchAction: gestures && layers.length > 1 ? "pan-y pinch-zoom" : undefined,
            paddingLeft: isMobile ? "calc(0.75rem + var(--safe-left))" : undefined,
            paddingRight: isMobile ? "calc(0.75rem + var(--safe-right))" : undefined,
            paddingBottom: isMobile && !footer ? "calc(0.75rem + var(--safe-bottom))" : undefined,
          }}
        >
          {body}
        </div>
        {footer}
      </div>
    </Modal>
  );
}

function TurnUnchangedList({ paths }: { paths: string[] }) {
  return (
    <div className="rounded-card border border-dashed border-line px-3 py-2 text-nano text-ink-faint">
      <p className="mb-1">上一轮还改过这些文件，但它们当前没有未提交的改动（已提交 / 已还原）：</p>
      <ul className="font-mono">
        {paths.map((p) => (
          <li key={p} className="truncate">
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}
