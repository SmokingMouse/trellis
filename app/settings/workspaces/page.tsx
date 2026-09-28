"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Check, FolderGit2, RefreshCw, TriangleAlert } from "lucide-react";
import { CliAttachPicker } from "@/components/CliAttachPicker";
import {
  Badge,
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  PageHeader,
  Skeleton,
  Tooltip,
  toast,
  useConfirm,
} from "@/components/ui";

// S89: 「工作区与 CLI」tab。
//
// 收的是两类**没有语境化的家**的管理动作：
// ① worktree 回收 —— 侧栏里它是一个 hover 才出现的小图标（S83 修过一次可达性），
//    而「哪些工作区已经并入主干可以回收了」是一个需要**通览**的问题，不是逐行 hover 的问题。
// ② CLI attach —— 原来只有侧栏底部一个 title 很长的虚线按钮，是 capability-report 里
//    典型的「唯一且隐蔽入口」。
//
// 刻意**不做**的：新建 worktree、在某个工作区开新会话。那两个有真正的语境化的家
// （侧栏项目行的 ＋、WorkspacePicker），搬进来只是多一跳 —— 这正是 decisions.md
// 2026-07-29 那条至今成立的一半。

type Workspace = {
  id: string;
  projectId: string;
  name: string;
  path: string;
  kind: string;
  gitBranch: string | null;
  createdBy: string;
  lastUsedAt: number | null;
  sessionCount: number;
};
type Project = {
  id: string;
  name: string;
  clusterKey: string;
  gitRemote: string | null;
  workspaces: Workspace[];
};
type GitStatus = {
  id: string;
  branch: string | null;
  dirty: number;
  reclaimable: boolean;
};

export default function WorkspacesSettingsPage() {
  // null = 首次加载中（骨架）；失败时保留 null 并给 loadError。
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [git, setGit] = useState<Map<string, GitStatus>>(new Map());
  const [gitFailed, setGitFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  // 保持 .then 链而不是 async/await：setState 必须待在回调里，
  // react-hooks/set-state-in-effect 才不会把下面 effect 里的这次调用判成同步 setState
  // （与 app/settings/update/page.tsx:67 同一个既定写法）。
  const load = useCallback((): Promise<void> => {
    const p1 = fetch("/api/workspaces")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setProjects(d.projects ?? []);
        setLoadError(null);
      })
      .catch((e: unknown) => setLoadError(e));
    // git-status **带副作用**：服务端每次都会 rescan + prune，所以它同时是「CLI 里
    // git worktree add 出来的目录出现在这里」的通道。10s TTL 缓存在服务端。
    const p2 = fetch("/api/workspaces/git-status")
      .then((r) => r.json())
      .then((g) => {
        setGit(new Map((g.statuses ?? []).map((s: GitStatus) => [s.id, s])));
        setGitFailed(false);
      })
      .catch(() => setGitFailed(true));
    return Promise.all([p1, p2]).then(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  // 删除 worktree。服务端是两阶段的：不带 force 一律**只预演绝不执行**，
  // 且预演成功也返回 409 —— 所以这里不能按 res.ok 判成败，必须解 body 看 preview。
  const removeWorktree = async (w: Workspace) => {
    setBusy(w.id);
    try {
      const res = await fetch(`/api/workspaces/worktree?workspaceId=${w.id}`, {
        method: "DELETE",
      });
      const r = await res.json().catch(() => ({}));
      if (r.ok) {
        toast.success("记录已清理", { description: `「${w.name}」目录已不在磁盘上` });
        await load();
        return;
      }
      if (!r.preview) {
        toast.error("删除失败", { description: r.error ?? "服务端没有给出原因" });
        return;
      }
      // 预演回来的两类清单都要摆给用户：dirty 是会丢的活，
      // ignored 是 .env* / .claude/ 这类**会被静默删掉**的东西（S79 丢过一次）。
      const dirty: string[] = r.dirty ?? [];
      const ignored: string[] = r.ignored ?? [];
      const ok = await confirm({
        title: `删除 worktree「${w.name}」？`,
        description: (
          <span className="flex flex-col gap-2">
            <span className="font-mono text-label break-all">{r.path}</span>
            {r.dirtyCount ? (
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-danger-ink">
                  <Icon icon={TriangleAlert} size="sm" />
                  {r.dirtyCount} 处未提交改动会丢失，无法恢复：
                </span>
                <span className="max-h-28 overflow-auto font-mono text-nano whitespace-pre-wrap">
                  {dirty.join("\n")}
                </span>
              </span>
            ) : (
              <span>工作区干净。</span>
            )}
            {r.ignoredCount ? (
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-danger-ink">
                  <Icon icon={TriangleAlert} size="sm" />
                  {r.ignoredCount} 个被 .gitignore 忽略的文件也会被删（.env / 本地配置常在其中）：
                </span>
                <span className="max-h-28 overflow-auto font-mono text-nano whitespace-pre-wrap">
                  {ignored.join("\n")}
                </span>
              </span>
            ) : null}
          </span>
        ),
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;

      const res2 = await fetch(
        `/api/workspaces/worktree?workspaceId=${w.id}&force=1`,
        { method: "DELETE" },
      );
      const r2 = await res2.json().catch(() => ({}));
      if (!res2.ok) {
        toast.error("删除失败", { description: r2.error ?? "服务端没有给出原因" });
        return;
      }
      toast.success(`已删除「${w.name}」`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const allWorkspaces = (projects ?? []).flatMap((p) => p.workspaces);
  const reclaimable = (projects ?? [])
    .flatMap((p) => p.workspaces)
    .filter((w) => git.get(w.id)?.reclaimable);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="工作区与 CLI"
        count={projects ? allWorkspaces.length : undefined}
        countUnit="个工作区"
        subtitle={
          projects
            ? `${projects.length} 个项目${reclaimable.length ? ` · ${reclaimable.length} 个可回收` : ""}`
            : undefined
        }
        actions={
          <>
            <IconButton label="刷新" onClick={refresh} disabled={refreshing}>
              <Icon icon={RefreshCw} className={refreshing ? "animate-spin" : undefined} />
            </IconButton>
            <Button variant="primary" onClick={() => setAttachOpen(true)}>
              <Icon icon={ArrowLeftRight} />
              管理 CLI 接入
            </Button>
          </>
        }
      />

      {gitFailed && (
        <ErrorCallout
          compact
          error={null}
          title="git 状态拉取失败"
          hint="分支、改动数与「可回收」标记暂不可用；工作区列表不受影响。"
          onRetry={refresh}
        />
      )}

      {/* 通览：这一屏存在的理由。逐行 hover 看不出「有几个可以回收了」。 */}
      {reclaimable.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-card border border-positive-line bg-positive-muted text-ui text-positive-ink">
          <Icon icon={Check} size="sm" className="mt-0.5" />
          <span>
            {reclaimable.length} 个 worktree 已并入主干且工作区干净，可以回收：
            {reclaimable.map((w) => w.name).join("、")}
          </span>
        </div>
      )}

      <section>
        <h2 className="text-ui font-semibold text-ink-strong mb-1">工作区</h2>
        <p className="text-label text-ink-muted mb-3">
          新建 worktree、在某个目录开会话都在侧栏就地做 —— 这里只管通览与回收。
          「可回收」= 分支已并入本地主干 + 工作区干净；squash / rebase 合并的认不出来（只会少报，不会误报）。
        </p>

        {projects === null && loadError === null && (
          <div role="status" aria-label="加载中" className="flex flex-col gap-3">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-card border border-line p-3 flex flex-col gap-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        )}

        {projects === null && loadError !== null && (
          <ErrorCallout error={loadError} title="工作区列表加载失败" onRetry={refresh} />
        )}

        {projects && !projects.length && (
          <EmptyState
            icon={FolderGit2}
            title="还没有工作区"
            description="在侧栏项目行点 ＋ 新建 worktree，或打开一个目录开会话，工作区就会登记在这里。"
            className="rounded-card border border-line"
          />
        )}

        <div className="flex flex-col gap-3">
          {(projects ?? []).map((p) => (
            <div key={p.id}>
              <div className="text-ui font-medium flex items-center gap-2">
                {p.name}
                {p.gitRemote && (
                  <span className="text-nano text-ink-faint font-mono truncate max-w-[24rem]">
                    {p.gitRemote}
                  </span>
                )}
              </div>
              <div className="mt-1.5 rounded-card border border-line bg-surface divide-y divide-line-faint">
                {p.workspaces.map((w) => {
                  const g = git.get(w.id);
                  const removable =
                    w.createdBy === "trellis" && w.kind === "worktree";
                  return (
                    <div
                      key={w.id}
                      className="px-3 py-2 flex items-center gap-3 text-label"
                    >
                      <span className="font-medium shrink-0">{w.name}</span>
                      <Badge className="shrink-0">{w.kind}</Badge>
                      {g?.branch && g.branch !== w.name && (
                        <span className="text-nano text-ink-faint font-mono shrink-0">
                          {g.branch}
                        </span>
                      )}
                      {!!g?.dirty && (
                        <Tooltip content={`${g.dirty} 个文件有改动或未跟踪`}>
                          <span className="shrink-0">
                            <Badge variant="warn" dot>
                              {g.dirty} 处改动
                            </Badge>
                          </span>
                        </Tooltip>
                      )}
                      {g?.reclaimable && (
                        <Tooltip content="已并入主干且工作区干净 —— 可以回收">
                          <span className="shrink-0">
                            <Badge variant="positive">
                              <Icon icon={Check} size="sm" />
                              可回收
                            </Badge>
                          </span>
                        </Tooltip>
                      )}
                      <span className="text-ink-faint font-mono truncate flex-1 min-w-0" title={w.path}>
                        {w.path}
                      </span>
                      <span className="text-nano text-ink-faint shrink-0">
                        {w.sessionCount} 会话
                      </span>
                      {removable ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          loading={busy === w.id}
                          onClick={() => void removeWorktree(w)}
                        >
                          删除
                        </Button>
                      ) : (
                        // 说清为什么不能删，而不是让按钮神秘消失。
                        <Tooltip
                          content={
                            w.kind !== "worktree"
                              ? "只有 worktree 能从这里删（主目录不动）"
                              : "这个 worktree 不是 Trellis 建的 —— 只登记不托管，请在命令行删"
                          }
                        >
                          <span tabIndex={0} className="text-nano text-ink-faint shrink-0 px-2">
                            —
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-ui font-semibold text-ink-strong mb-1">CLI 会话接入</h2>
        <p className="text-label text-ink-muted">
          把本机 Claude Code / Codex CLI 里已有的会话接进 Trellis（原始会话记录文件不动）。
          入口在页头「管理 CLI 接入」，侧栏底部也有同一个入口。
        </p>
      </section>

      {attachOpen && (
        <CliAttachPicker onClose={() => setAttachOpen(false)} onChanged={() => void load()} />
      )}
    </div>
  );
}
