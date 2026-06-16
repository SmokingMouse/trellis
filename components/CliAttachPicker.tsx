"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    <div className="group flex items-center gap-2 pr-3 h-8 hover:bg-stone-50 dark:hover:bg-stone-800/60">
      <div className="flex-1 min-w-0">
        <div
          className="truncate text-[12px] text-stone-600 dark:text-stone-300"
          title={s.title}
        >
          {s.title}
        </div>
        {showCwd && s.cwd && (
          <div className="truncate text-[9.5px] text-stone-400" title={s.cwd}>
            {shortCwd(s.cwd)}
          </div>
        )}
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-stone-400">
        {s.turns}轮 · {fmtDate(s.updatedAt)}
      </span>
      {s.attached ? (
        <span className="shrink-0 text-[10.5px] text-emerald-600 dark:text-emerald-400 px-1.5">
          ✓ 已 attach
        </span>
      ) : (
        <button
          onClick={() => attach(s.jsonlPath, dir)}
          disabled={busy === s.jsonlPath}
          className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 hover:bg-stone-700 dark:hover:bg-stone-300 disabled:opacity-50"
        >
          {busy === s.jsonlPath ? "…" : "attach"}
        </button>
      )}
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[8vh] px-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl max-h-[80vh] flex flex-col rounded-xl bg-white dark:bg-stone-900 shadow-2xl ring-1 ring-stone-200 dark:ring-stone-700 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="shrink-0 px-4 py-3 border-b border-stone-100 dark:border-stone-800 flex items-center gap-2">
          <span className="text-[13px] font-semibold text-stone-800 dark:text-stone-100">
            ⇄ Attach 本机 CLI 会话
          </span>
          <span className="text-[11px] text-stone-400 dark:text-stone-500">
            双向同步
          </span>
          <button
            onClick={onClose}
            className="ml-auto shrink-0 w-6 h-6 flex items-center justify-center rounded text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* tabs + search */}
        <div className="shrink-0 px-3 py-2 border-b border-stone-100 dark:border-stone-800 flex items-center gap-2">
          <div className="flex rounded-md bg-stone-100 dark:bg-stone-800 p-0.5 text-[11.5px]">
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
                    ? "bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-100 shadow-sm"
                    : "text-stone-500 dark:text-stone-400"
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
            className="flex-1 min-w-0 h-7 px-2 rounded-md bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-[12px] text-stone-700 dark:text-stone-200 placeholder:text-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-300 dark:focus:ring-stone-600"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* 已 attach */}
          {attached.length > 0 && (
            <div className="px-3 py-2 border-b border-stone-100 dark:border-stone-800">
              <div className="px-1 pb-1 text-[10.5px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                已 attach ({attached.length})
              </div>
              {attached.map((a) => (
                <div
                  key={a.id}
                  className="group flex items-center gap-2 px-2 h-7 rounded-md hover:bg-stone-50 dark:hover:bg-stone-800/60"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <span
                    className="flex-1 min-w-0 truncate text-[12px] text-stone-700 dark:text-stone-200"
                    title={a.sourceJsonlPath ?? a.title}
                  >
                    {a.title}
                  </span>
                  <button
                    onClick={() => detach(a.id)}
                    disabled={busy === a.id}
                    className="shrink-0 text-[11px] px-1.5 py-0.5 rounded text-stone-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50"
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
              <div className="px-4 py-6 text-center text-[12px] text-stone-400">
                加载中…
              </div>
            ) : recentFiltered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-stone-400">
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
              <div className="px-4 py-6 text-center text-[12px] text-stone-400">
                加载中…
              </div>
            ) : projectsFiltered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12px] text-stone-400">
                {query ? "无匹配" : "没有可 attach 的 CLI 会话"}
              </div>
            ) : (
              <div className="py-1">
                {projectsFiltered.map((p) => (
                  <div key={p.dir}>
                    <button
                      onClick={() => expandDir(p.dir)}
                      className="w-full flex items-center gap-2 px-3 h-8 hover:bg-stone-50 dark:hover:bg-stone-800/60 text-left"
                    >
                      <span className="text-[9px] text-stone-400 w-2 shrink-0">
                        {openDir === p.dir ? "▾" : "▸"}
                      </span>
                      <span
                        className="flex-1 min-w-0 truncate text-[12px] text-stone-700 dark:text-stone-200"
                        title={p.cwd ?? p.dir}
                      >
                        {shortCwd(p.cwd) || p.dir}
                      </span>
                      <span className="shrink-0 text-[10.5px] tabular-nums text-stone-400">
                        {p.sessionCount}
                      </span>
                    </button>
                    {openDir === p.dir && (
                      <div className="pb-1 pl-6">
                        {!dirSessions[p.dir] ? (
                          <div className="px-3 py-2 text-[11px] text-stone-400 italic">
                            加载中…
                          </div>
                        ) : dirSessions[p.dir].length === 0 ? (
                          <div className="px-3 py-2 text-[11px] text-stone-400 italic">
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

        <div className="shrink-0 px-4 py-2 border-t border-stone-100 dark:border-stone-800 text-[10.5px] text-stone-400 dark:text-stone-500">
          提示：同一会话别在 CLI 和 trellis 里同时聊（两边抢写同一文件）。串行使用无碍。
        </div>
      </div>
    </div>
  );
}
