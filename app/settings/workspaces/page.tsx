"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { CliAttachPicker } from "@/components/CliAttachPicker";

// S89: 「工作区 / CLI」tab。
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [git, setGit] = useState<Map<string, GitStatus>>(new Map());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  // 保持 .then 链而不是 async/await：setState 必须待在回调里，
  // react-hooks/set-state-in-effect 才不会把下面 effect 里的这次调用判成同步 setState
  // （与 app/settings/update/page.tsx:67 同一个既定写法）。
  const load = useCallback((): Promise<void> => {
    const p1 = fetch("/api/workspaces")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => {
        /* 静默 —— 下面 git-status 那次失败会给出提示 */
      });
    // git-status **带副作用**：服务端每次都会 rescan + prune，所以它同时是「CLI 里
    // git worktree add 出来的目录出现在这里」的通道。10s TTL 缓存在服务端。
    const p2 = fetch("/api/workspaces/git-status")
      .then((r) => r.json())
      .then((g) =>
        setGit(new Map((g.statuses ?? []).map((s: GitStatus) => [s.id, s]))),
      )
      .catch(() => setMsg("git 状态拉取失败（分支 / 可回收标记不可用）"));
    return Promise.all([p1, p2]).then(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 删除 worktree。服务端是两阶段的：不带 force 一律**只预演绝不执行**，
  // 且预演成功也返回 409 —— 所以这里不能按 res.ok 判成败，必须解 body 看 preview。
  const removeWorktree = async (w: Workspace) => {
    setMsg(null);
    setBusy(w.id);
    try {
      const res = await fetch(`/api/workspaces/worktree?workspaceId=${w.id}`, {
        method: "DELETE",
      });
      const r = await res.json().catch(() => ({}));
      if (r.ok) {
        setMsg(`「${w.name}」目录已不在磁盘上，记录已清理`);
        await load();
        return;
      }
      if (!r.preview) {
        setMsg(r.error ?? "删除失败");
        return;
      }
      // 预演回来的两类清单都要摆给用户：dirty 是会丢的活，
      // ignored 是 .env* / .claude/ 这类**会被静默删掉**的东西（S79 丢过一次）。
      const lines = [
        `删除 worktree「${w.name}」？`,
        r.path,
        "",
        r.dirtyCount
          ? `⚠ ${r.dirtyCount} 处未提交改动会丢失：\n${(r.dirty ?? []).join("\n")}`
          : "工作区干净",
        r.ignoredCount
          ? `⚠ ${r.ignoredCount} 个被 .gitignore 忽略的文件也会被删（.env / 本地配置常在其中）：\n${(r.ignored ?? []).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (!confirm(lines)) return;

      const res2 = await fetch(
        `/api/workspaces/worktree?workspaceId=${w.id}&force=1`,
        { method: "DELETE" },
      );
      const r2 = await res2.json().catch(() => ({}));
      if (!res2.ok) {
        setMsg(r2.error ?? "删除失败");
        return;
      }
      setMsg(`已删除「${w.name}」`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const reclaimable = projects
    .flatMap((p) => p.workspaces)
    .filter((w) => git.get(w.id)?.reclaimable);

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      {msg && (
        <div className="px-3 py-2 rounded-md border border-line bg-surface-muted text-ui text-ink-muted">
          {msg}
        </div>
      )}

      {/* 通览：这一屏存在的理由。逐行 hover 看不出「有几个可以回收了」。 */}
      {reclaimable.length > 0 && (
        <div className="px-3 py-2 rounded-md border border-positive-line bg-positive-muted text-ui text-positive-ink">
          {reclaimable.length} 个 worktree 已并入主干且工作区干净，可以回收：
          {reclaimable.map((w) => w.name).join("、")}
        </div>
      )}

      <section className="rounded-card border border-line bg-surface shadow-raise p-4">
        <h2 className="text-ui font-medium mb-1">工作区</h2>
        <p className="text-label text-ink-faint mb-3">
          新建 worktree、在某个目录开会话都在侧栏就地做 —— 这里只管**通览与回收**。
          「可回收」= 分支已并入本地主干 + 工作区干净；漏报 squash / rebase 合并（方向安全）。
        </p>

        {!projects.length && (
          <div className="text-ui text-ink-faint py-3">还没有登记任何工作区。</div>
        )}

        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <div key={p.id}>
              <div className="text-ui font-medium flex items-center gap-2">
                {p.name}
                {p.gitRemote && (
                  <span className="text-nano text-ink-faint font-mono truncate max-w-[24rem]">
                    {p.gitRemote}
                  </span>
                )}
              </div>
              <div className="mt-1 rounded-md border border-line-faint divide-y divide-line-faint">
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
                      <span className="text-nano text-ink-faint border border-line rounded-full px-1.5 shrink-0">
                        {w.kind}
                      </span>
                      {g?.branch && g.branch !== w.name && (
                        <span className="text-nano text-ink-faint font-mono shrink-0">
                          {g.branch}
                        </span>
                      )}
                      {!!g?.dirty && (
                        <span className="text-nano text-warn shrink-0" title={`${g.dirty} 个文件有改动或未跟踪`}>
                          ●{g.dirty}
                        </span>
                      )}
                      {g?.reclaimable && (
                        <span className="text-nano text-positive shrink-0" title="已并入主干且工作区干净 —— 可以回收">
                          ✓ 可回收
                        </span>
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
                          disabled={busy === w.id}
                          onClick={() => void removeWorktree(w)}
                        >
                          {busy === w.id ? "…" : "删除"}
                        </Button>
                      ) : (
                        // 说清为什么不能删，而不是让按钮神秘消失。
                        <span
                          className="text-nano text-ink-faint shrink-0"
                          title={
                            w.kind !== "worktree"
                              ? "只有 worktree 能从这里删（主 checkout 不动）"
                              : "这个 worktree 不是 trellis 建的 —— 只登记不托管，请在命令行删"
                          }
                        >
                          —
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-card border border-line bg-surface shadow-raise p-4">
        <h2 className="text-ui font-medium mb-1">CLI 会话接入</h2>
        <p className="text-label text-ink-faint mb-3">
          把本机 Claude Code / Codex CLI 里已有的会话接进 Trellis（原始 jsonl 不动）。
          侧栏底部也有同一个入口。
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => setAttachOpen(true)}>
          ⇄ 管理 CLI 接入
        </Button>
      </section>

      {attachOpen && (
        <CliAttachPicker onClose={() => setAttachOpen(false)} onChanged={() => void load()} />
      )}
    </div>
  );
}
