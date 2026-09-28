"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Link2, Search, X } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  SegmentedControl,
  SkeletonText,
  Spinner,
  StatusDot,
  toast,
} from "@/components/ui";
import { describeError } from "@/lib/error-copy";

// CLI 同步 Stage 3：attach picker（界面文案叫「接入」）。浏览本机 Claude Code / Codex
// CLI 会话，接入进 trellis。两个视图：「最近活跃」（跨项目按最后活动时间扁平排，常用的
// 浮顶）+「按项目」（目录分组懒加载）。顶部搜索框按标题/路径过滤。接入后双向同步；
// 解除接入只解绑、不删原始会话记录文件（jsonl）。
// 数据源：/api/cli-sync/discover（provider + recent/project）+ /api/cli-sync/attach。

type Project = {
  provider: "claude" | "codex";
  key: string;
  cwd: string | null;
  sessionCount: number;
  latestMtime: number;
};
type CliSession = {
  provider: "claude" | "codex";
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
  provider: "claude" | "codex";
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
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<CliSession[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [openDir, setOpenDir] = useState<string | null>(null);
  const [dirSessions, setDirSessions] = useState<Record<string, CliSession[]>>(
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const loadAttached = useCallback(async () => {
    try {
      const a = await fetch("/api/cli-sync/attach").then((r) => r.json());
      setAttached(a.attached ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/cli-sync/discover?provider=${provider}&recent=1`,
      ).then((res) => res.json());
      setRecent(r.sessions ?? []);
    } catch (e) {
      setError(e);
      setRecent([]);
    }
  }, [provider]);

  const loadProjects = useCallback(async () => {
    if (projects) return;
    try {
      const p = await fetch(
        `/api/cli-sync/discover?provider=${provider}`,
      ).then((r) => r.json());
      setProjects(p.projects ?? []);
    } catch (e) {
      setError(e);
      setProjects([]);
    }
  }, [projects, provider]);

  // 初次：拉已 attach + 最近活跃（默认 tab）。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAttached();
      void loadRecent();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAttached, loadRecent]);

  const switchProvider = useCallback((next: "claude" | "codex") => {
    if (next === provider) return;
    setProvider(next);
    setRecent(null);
    setProjects(null);
    setOpenDir(null);
    setDirSessions({});
    setError(null);
  }, [provider]);

  // 切到「按项目」时懒加载项目清单。
  useEffect(() => {
    if (tab !== "projects") return;
    const timer = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(timer);
  }, [tab, loadProjects]);

  // Esc 无条件关闭（含搜索框聚焦时）由 Modal 的 closeOnEsc="always" 提供。

  const expandDir = useCallback(
    async (projectKey: string) => {
      if (openDir === projectKey) {
        setOpenDir(null);
        return;
      }
      setOpenDir(projectKey);
      if (!dirSessions[projectKey]) {
        try {
          const r = await fetch(
            `/api/cli-sync/discover?provider=${provider}&project=${encodeURIComponent(projectKey)}`,
          ).then((res) => res.json());
          setDirSessions((s) => ({ ...s, [projectKey]: r.sessions ?? [] }));
        } catch {
          setDirSessions((s) => ({ ...s, [projectKey]: [] }));
        }
      }
    },
    [openDir, dirSessions, provider],
  );

  // attach/detach 后刷新所有受影响的视图。
  const refreshAll = useCallback(
    async (projectKey: string | null) => {
      onChanged();
      await Promise.all([loadAttached(), loadRecent()]);
      setProjects(null); // 计数变了，下次切过去重拉
      if (projectKey) {
        const r = await fetch(
          `/api/cli-sync/discover?provider=${provider}&project=${encodeURIComponent(projectKey)}`,
        ).then((res) => res.json());
        setDirSessions((s) => ({ ...s, [projectKey]: r.sessions ?? [] }));
      }
    },
    [loadAttached, loadRecent, onChanged, provider],
  );

  const attach = useCallback(
    async (jsonlPath: string, projectKey: string | null) => {
      setBusy(jsonlPath);
      try {
        const res = await fetch("/api/cli-sync/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "attach", jsonlPath, provider }),
        });
        if (!res.ok) throw await httpError(res);
        await refreshAll(projectKey);
      } catch (e) {
        toast.error("接入失败", { description: errorText(e) });
      } finally {
        setBusy(null);
      }
    },
    [refreshAll, provider],
  );

  const detach = useCallback(
    async (sessionId: string) => {
      setBusy(sessionId);
      try {
        const res = await fetch("/api/cli-sync/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "detach", sessionId }),
        });
        if (!res.ok) throw await httpError(res);
        await refreshAll(openDir);
      } catch (e) {
        toast.error("解除接入失败", { description: errorText(e) });
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
        p.key.toLowerCase().includes(q),
    );
  }, [projects, q]);

  const SessionRow = ({
    s,
    projectKey,
    showCwd,
  }: {
    s: CliSession;
    projectKey: string | null;
    showCwd: boolean;
  }) => (
    <div className="group flex items-center gap-2 px-2 py-1 min-h-8 rounded-field hover:bg-surface-hover">
      <div className="flex-1 min-w-0">
        <div className="truncate text-ui text-ink" title={s.title}>
          {s.title}
        </div>
        {showCwd && s.cwd && (
          <div className="truncate text-nano font-mono text-ink-faint" title={s.cwd}>
            {shortCwd(s.cwd)}
          </div>
        )}
      </div>
      <span className="shrink-0 text-label tabular-nums text-ink-faint">
        {s.turns} 轮 · {fmtDate(s.updatedAt)}
      </span>
      {s.attached ? (
        <span className="shrink-0 inline-flex items-center gap-1 px-2 text-label text-positive-ink">
          <Icon icon={Check} size="sm" />
          已接入
        </span>
      ) : (
        <Button
          size="sm"
          variant="primary"
          onClick={() => attach(s.jsonlPath, projectKey)}
          loading={busy === s.jsonlPath}
          disabled={busy !== null}
        >
          接入
        </Button>
      )}
    </div>
  );

  const listEmpty = (
    <EmptyState
      compact
      icon={query ? Search : Link2}
      title={query ? `没有匹配「${query.trim()}」的会话` : "没有可接入的 CLI 会话"}
      description={query ? "按标题或项目路径过滤。" : "在终端里用 Claude Code / Codex 聊过之后，会话会出现在这里。"}
    />
  );

  return (
    <Modal
      onClose={onClose}
      closeOnEsc="always"
      title="接入本机 CLI 会话"
      panelClassName="flex flex-col max-h-[80vh]"
    >
      {/* header */}
      <div className="shrink-0 px-4 py-3 border-b border-line-faint flex items-center gap-2">
        <h2 className="text-ui font-semibold text-ink-strong">接入本机 CLI 会话</h2>
        <span className="text-label text-ink-faint">接入后双向同步</span>
        <IconButton label="关闭" size="sm" className="ml-auto" onClick={onClose}>
          <Icon icon={X} />
        </IconButton>
      </div>

      {/* provider + view + search */}
      <div className="shrink-0 px-3 py-2 border-b border-line-faint flex flex-wrap items-center gap-2">
        <SegmentedControl
          size="sm"
          aria-label="CLI 来源"
          value={provider}
          onValueChange={switchProvider}
          options={[
            { value: "claude", label: "Claude" },
            { value: "codex", label: "Codex" },
          ]}
        />
        <SegmentedControl
          size="sm"
          aria-label="浏览方式"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "recent", label: "最近活跃" },
            { value: "projects", label: "按项目" },
          ]}
        />
        <Input
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索标题 / 项目路径…"
          aria-label="搜索 CLI 会话"
          leading={<Icon icon={Search} size="sm" />}
          wrapperClassName="flex-1 min-w-40"
        />
      </div>

      {!!error && (
        <div className="shrink-0 px-3 py-2 border-b border-line-faint">
          <ErrorCallout compact error={error} title="读取本机 CLI 会话失败" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* 已接入 */}
        {attached.length > 0 && (
          <div className="px-2 py-2 border-b border-line-faint">
            <div className="px-2 pb-1 text-label font-medium text-ink-muted">
              已接入（{attached.length}）
            </div>
            {attached.map((a) => (
              <div
                key={a.id}
                className="group flex items-center gap-2 px-2 min-h-8 rounded-field hover:bg-surface-hover"
              >
                <StatusDot tone="positive" />
                <span className="shrink-0 text-nano uppercase text-ink-faint">{a.provider}</span>
                <span
                  className="flex-1 min-w-0 truncate text-ui text-ink"
                  title={a.sourceJsonlPath ?? a.title}
                >
                  {a.title}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => detach(a.id)}
                  loading={busy === a.id}
                  disabled={busy !== null}
                  title="只解除绑定，不删除 CLI 那边的会话记录文件"
                >
                  解除接入
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* 最近活跃 */}
        {tab === "recent" &&
          (recentFiltered === null ? (
            <SkeletonText lines={4} className="px-4 py-4" />
          ) : recentFiltered.length === 0 ? (
            listEmpty
          ) : (
            <div className="py-1 px-1.5">
              {recentFiltered.map((s) => (
                <SessionRow key={s.jsonlPath} s={s} projectKey={null} showCwd />
              ))}
            </div>
          ))}

        {/* 按项目 */}
        {tab === "projects" &&
          (projectsFiltered === null ? (
            <SkeletonText lines={4} className="px-4 py-4" />
          ) : projectsFiltered.length === 0 ? (
            listEmpty
          ) : (
            <div className="py-1 px-1.5">
              {projectsFiltered.map((p) => (
                <div key={p.key}>
                  <button
                    type="button"
                    onClick={() => expandDir(p.key)}
                    aria-expanded={openDir === p.key}
                    className="w-full flex items-center gap-2 px-2 min-h-8 rounded-field hover:bg-surface-hover text-left"
                  >
                    <Icon
                      icon={openDir === p.key ? ChevronDown : ChevronRight}
                      size="sm"
                      className="text-ink-faint"
                    />
                    <span
                      className="flex-1 min-w-0 truncate text-ui font-mono text-ink"
                      title={p.cwd ?? p.key}
                    >
                      {shortCwd(p.cwd) || "无工作目录"}
                    </span>
                    <span className="shrink-0 text-label tabular-nums text-ink-faint">
                      {p.sessionCount}
                    </span>
                  </button>
                  {openDir === p.key && (
                    <div className="pb-1 pl-6">
                      {!dirSessions[p.key] ? (
                        <div className="px-3 py-2">
                          <Spinner size="sm" />
                        </div>
                      ) : dirSessions[p.key].length === 0 ? (
                        <div className="px-3 py-2 text-label text-ink-faint">这个项目下没有会话</div>
                      ) : (
                        dirSessions[p.key].map((s) => (
                          <SessionRow key={s.jsonlPath} s={s} projectKey={p.key} showCwd={false} />
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
      </div>

      <div className="shrink-0 px-4 py-2 border-t border-line-faint text-label text-ink-faint">
        同一个会话别在 CLI 和 trellis 两边同时聊（会抢写同一个会话记录文件），轮流用没问题。
      </div>
    </Modal>
  );
}

async function httpError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? `HTTP ${res.status}`);
}

// toast 描述：能归类的错误给人话，认不出的（多半是服务端给的中文原因）原样给。
function errorText(e: unknown): string {
  const copy = describeError(e);
  return copy.what === "操作没有完成" ? copy.raw : `${copy.what}，${copy.hint}`;
}
