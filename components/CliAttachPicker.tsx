"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { IconButton } from "@/components/ui/IconButton";

// CLI 同步 Stage 3：attach picker。浏览本机 Claude Code CLI 会话，勾选 attach 进 trellis。
// 两个视图：「最近活跃」（跨项目按最后活动时间扁平排，常用的浮顶）+「按项目」（目录分组懒加载）。
// 顶部搜索框按标题/路径过滤。attach 后双向绑定；detach 只解绑、不删原始 jsonl。
// 数据源：/api/cli-sync/discover（清单 / ?recent / ?dir）+ /api/cli-sync/attach（attach/detach）。

type Project = {
  dir: string;
  cwd: string | null;
  sessionCount: number;
  latestMtime: number;
};
type CliSession = {
  jsonlPath: string;
  sessionId: string;
  title: string;
  turns: number;
  updatedAt: number;
  attached: boolean;
  cwd?: string | null;
};
type Attached = {
  id: string;
  title: string;
  sourceJsonlPath: string | null;
  workspacePath: string | null;
  updatedAt: number;
};

function fmtDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shortCwd(cwd: string | null | undefined): string {
  if (!cwd) return "";
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

export function CliAttachPicker({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"recent" | "projects">("recent");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<CliSession[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [openDir, setOpenDir] = useState<string | null>(null);
  const [dirSessions, setDirSessions] = useState<Record<string, CliSession[]>>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAttached = useCallback(async () => {
    try {
      const a = await fetch("/api/cli-sync/attach").then((r) => r.json());
      setAttached(a.attached ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadRecent = useCallback(async () => {
    setRecent(null);
    try {
      const r = await fetch("/api/cli-sync/discover?recent=1").then((res) =>
        res.json(),
      );
      setRecent(r.sessions ?? []);
    } catch {
      setError("加载失败");
      setRecent([]);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    if (projects) return;
    try {
      const p = await fetch("/api/cli-sync/discover").then((r) => r.json());
      setProjects(p.projects ?? []);
    } catch {
      setError("加载失败");
      setProjects([]);
    }
  }, [projects]);

  // 初次：拉已 attach + 最近活跃（默认 tab）。
  useEffect(() => {
    void loadAttached();
    void loadRecent();
  }, [loadAttached, loadRecent]);

  // 切到「按项目」时懒加载项目清单。
  useEffect(() => {
    if (tab === "projects") void loadProjects();
  }, [tab, loadProjects]);

  // Esc 无条件关闭（含搜索框聚焦时）由 Modal 的 closeOnEsc="always" 提供。

  const expandDir = useCallback(
    async (dir: string) => {
      if (openDir === dir) {
        setOpenDir(null);
        return;
      }
      setOpenDir(dir);
      if (!dirSessions[dir]) {
        try {
          const r = await fetch(
            `/api/cli-sync/discover?dir=${encodeURIComponent(dir)}`,
          ).then((res) => res.json());
          setDirSessions((s) => ({ ...s, [dir]: r.sessions ?? [] }));
        } catch {
          setDirSessions((s) => ({ ...s, [dir]: [] }));
        }
      }
    },
    [openDir, dirSessions],
  );

  // attach/detach 后刷新所有受影响的视图。
  const refreshAll = useCallback(
    async (dir: string | null) => {
      onChanged();
      await Promise.all([loadAttached(), loadRecent()]);
      setProjects(null); // 计数变了，下次切过去重拉
      if (dir) {
        const r = await fetch(
          `/api/cli-sync/discover?dir=${encodeURIComponent(dir)}`,
        ).then((res) => res.json());
        setDirSessions((s) => ({ ...s, [dir]: r.sessions ?? [] }));
      }
    },
    [loadAttached, loadRecent, onChanged],
  );

  const attach = useCallback(
    async (jsonlPath: string, dir: string | null) => {
      setBusy(jsonlPath);
      try {
        await fetch("/api/cli-sync/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "attach", jsonlPath }),
        });
        await refreshAll(dir);
      } finally {
        setBusy(null);
      }
    },
    [refreshAll],
  );

  const detach = useCallback(
    async (sessionId: string) => {
      setBusy(sessionId);
      try {
        await fetch("/api/cli-sync/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "detach", sessionId }),
        });
        await refreshAll(openDir);
      } finally {
        setBusy(null);
      }
    },
    [refreshAll, openDir],
  );

  const q = query.trim().toLowerCase();
  const recentFiltered = useMemo(() => {
    if (!recent) return null;
    if (!q) return recent;
    return recent.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.cwd ?? "").toLowerCase().includes(q),
    );
  }, [recent, q]);
  const projectsFiltered = useMemo(() => {
    if (!projects) return null;
    if (!q) return projects;
    return projects.filter(
      (p) =>
        (p.cwd ?? "").toLowerCase().includes(q) ||
        p.dir.toLowerCase().includes(q),
    );
  }, [projects, q]);

  const SessionRow = ({
    s,
    dir,
    showCwd,
  }: {
    s: CliSession;
    dir: string | null;
    showCwd: boolean;
  }) => (
    <div className="group flex items-center gap-2 pr-3 h-8 hover:bg-surface-muted">
      <div className="flex-1 min-w-0">
        <div
          className="truncate text-ui text-ink-muted"
          title={s.title}
        >
          {s.title}
        </div>
        {showCwd && s.cwd && (
          <div className="truncate text-nano text-ink-faint" title={s.cwd}>
            {shortCwd(s.cwd)}
          </div>
        )}
      </div>
      <span className="shrink-0 text-nano tabular-nums text-ink-faint">
        {s.turns}轮 · {fmtDate(s.updatedAt)}
      </span>
      {s.attached ? (
        <span className="shrink-0 text-nano text-positive px-1.5">
          ✓ 已 attach
        </span>
      ) : (
        <button
          onClick={() => attach(s.jsonlPath, dir)}
          disabled={busy === s.jsonlPath}
          className="shrink-0 text-label px-2 py-0.5 rounded bg-accent hover:bg-accent-strong text-ink-inverse disabled:opacity-50"
        >
          {busy === s.jsonlPath ? "…" : "attach"}
        </button>
      )}
    </div>
  );

  return (
    <Modal onClose={onClose} closeOnEsc="always" panelClassName="flex flex-col max-h-[80vh]">
        {/* header */}
        <div className="shrink-0 px-4 py-3 border-b border-line-faint flex items-center gap-2">
          <span className="text-ui font-semibold text-ink-strong">
            ⇄ Attach 本机 CLI 会话
          </span>
          <span className="text-label text-ink-faint">
            双向同步
          </span>
          <IconButton label="关闭" size="sm" className="ml-auto" onClick={onClose}>
            ✕
          </IconButton>
        </div>

        {/* tabs + search */}
        <div className="shrink-0 px-3 py-2 border-b border-line-faint flex items-center gap-2">
          <div className="flex rounded-md bg-surface-muted p-0.5 text-label">
            {(
              [
                ["recent", "最近活跃"],
                ["projects", "按项目"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-2.5 py-1 rounded ${
                  tab === k
                    ? "bg-surface text-ink-strong shadow-raise"
                    : "text-ink-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 项目路径…"
            className="flex-1 min-w-0 h-7 px-2 rounded-md bg-surface-muted border border-line text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-line-strong"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* 已 attach */}
          {attached.length > 0 && (
            <div className="px-3 py-2 border-b border-line-faint">
              <div className="px-1 pb-1 text-nano font-medium uppercase tracking-wide text-positive">
                已 attach ({attached.length})
              </div>
              {attached.map((a) => (
                <div
                  key={a.id}
                  className="group flex items-center gap-2 px-2 h-7 rounded-md hover:bg-surface-muted"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-positive shrink-0" />
                  <span
                    className="flex-1 min-w-0 truncate text-ui text-ink"
                    title={a.sourceJsonlPath ?? a.title}
                  >
                    {a.title}
                  </span>
                  <button
                    onClick={() => detach(a.id)}
                    disabled={busy === a.id}
                    className="shrink-0 text-label px-1.5 py-0.5 rounded text-ink-muted hover:text-danger hover:bg-danger-muted disabled:opacity-50"
                  >
                    {busy === a.id ? "…" : "detach"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 最近活跃 */}
          {tab === "recent" &&
            (recentFiltered === null ? (
              <div className="px-4 py-6 text-center text-ui text-ink-faint">
                加载中…
              </div>
            ) : recentFiltered.length === 0 ? (
              <div className="px-4 py-6 text-center text-ui text-ink-faint">
                {query ? "无匹配" : "没有可 attach 的 CLI 会话"}
              </div>
            ) : (
              <div className="py-1 px-1">
                {recentFiltered.map((s) => (
                  <SessionRow
                    key={s.jsonlPath}
                    s={s}
                    dir={null}
                    showCwd
                  />
                ))}
              </div>
            ))}

          {/* 按项目 */}
          {tab === "projects" &&
            (projectsFiltered === null ? (
              <div className="px-4 py-6 text-center text-ui text-ink-faint">
                加载中…
              </div>
            ) : projectsFiltered.length === 0 ? (
              <div className="px-4 py-6 text-center text-ui text-ink-faint">
                {query ? "无匹配" : "没有可 attach 的 CLI 会话"}
              </div>
            ) : (
              <div className="py-1">
                {projectsFiltered.map((p) => (
                  <div key={p.dir}>
                    <button
                      onClick={() => expandDir(p.dir)}
                      className="w-full flex items-center gap-2 px-3 h-8 hover:bg-surface-muted text-left"
                    >
                      <span className="text-nano text-ink-faint w-2 shrink-0">
                        {openDir === p.dir ? "▾" : "▸"}
                      </span>
                      <span
                        className="flex-1 min-w-0 truncate text-ui text-ink"
                        title={p.cwd ?? p.dir}
                      >
                        {shortCwd(p.cwd) || p.dir}
                      </span>
                      <span className="shrink-0 text-nano tabular-nums text-ink-faint">
                        {p.sessionCount}
                      </span>
                    </button>
                    {openDir === p.dir && (
                      <div className="pb-1 pl-6">
                        {!dirSessions[p.dir] ? (
                          <div className="px-3 py-2 text-label text-ink-faint italic">
                            加载中…
                          </div>
                        ) : dirSessions[p.dir].length === 0 ? (
                          <div className="px-3 py-2 text-label text-ink-faint italic">
                            无
                          </div>
                        ) : (
                          dirSessions[p.dir].map((s) => (
                            <SessionRow
                              key={s.jsonlPath}
                              s={s}
                              dir={p.dir}
                              showCwd={false}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
        </div>

        <div className="shrink-0 px-4 py-2 border-t border-line-faint text-nano text-ink-faint">
          提示：同一会话别在 CLI 和 trellis 里同时聊（两边抢写同一文件）。串行使用无碍。
        </div>
    </Modal>
  );
}
