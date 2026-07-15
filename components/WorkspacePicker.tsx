"use client";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";

export type WorkspaceEntry = {
  path: string;
  shortName: string;
  lastUsedAt: number;
  source: "trellis" | "claude" | "both";
};

type Props = {
  // null = "no workspace yet" entry state; non-null = "currently picked, may
  // re-pick" entry state. Used to seed list highlighting only.
  currentPath: string | null;
  onPick: (path: string | null) => void;
  onClose: () => void;
};

type Tab = "recent" | "browse";

export function WorkspacePicker({ currentPath, onPick, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("recent");
  const [customPath, setCustomPath] = useState("");
  const [scratchBusy, setScratchBusy] = useState(false);
  const [scratchError, setScratchError] = useState<string | null>(null);

  // Esc-to-close（input 聚焦时不拦截）由 Modal 的 closeOnEsc="outside-inputs"
  // 默认行为提供，与旧手写监听语义一致。

  const pickPath = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    onPick(trimmed);
    onClose();
  };

  // "Blank sandbox": server mkdirs a fresh random empty dir under
  // ~/.trellis/scratch/ and we pick it like any other workspace path —
  // downstream (session creation, spawn cwd, previews) needs no special
  // casing.
  const createScratch = async () => {
    if (scratchBusy) return;
    setScratchBusy(true);
    setScratchError(null);
    try {
      const res = await fetch("/api/workspaces/scratch", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        path?: string;
        error?: string;
      };
      if (!res.ok || !body.path) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      pickPath(body.path);
    } catch (err) {
      setScratchError(err instanceof Error ? err.message : String(err));
      setScratchBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} panelClassName="flex flex-col max-h-[85vh]">
      <div className="border-b border-line-faint px-4 py-3 flex items-center gap-3 shrink-0">
        <span aria-hidden className="text-lg">
          📁
        </span>
        <div className="flex-1">
          <div className="text-sm font-medium">选择工作区</div>
          <div className="text-xs text-ink-muted">
            AI 将在该目录下执行工具调用 (cwd)
          </div>
        </div>
        <IconButton label="关闭" onClick={onClose}>
          ✕
        </IconButton>
      </div>

      <div className="border-b border-line-faint px-4 py-2 shrink-0">
        <button
          onClick={createScratch}
          disabled={scratchBusy}
          className="w-full text-left px-3 py-2 rounded-field border border-dashed border-positive-line bg-positive-muted/60 hover:bg-positive-muted transition-colors flex items-center gap-3 disabled:opacity-60 disabled:cursor-wait"
        >
          <span aria-hidden className="text-base shrink-0">
            ✨
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-positive-ink">
              {scratchBusy ? "创建中…" : "空白沙箱"}
            </span>
            <span className="block text-xs text-positive-ink/70">
              不挑目录 — 新建一个随机空目录作为 cwd（~/.trellis/scratch/）
            </span>
          </span>
        </button>
        {scratchError && (
          <div className="mt-1.5 text-xs text-danger">
            创建失败: {scratchError}
          </div>
        )}
      </div>

      <div className="border-b border-line-faint px-2 pt-2 shrink-0">
        <div className="flex gap-1">
          <TabButton
            active={tab === "recent"}
            onClick={() => setTab("recent")}
          >
            最近
          </TabButton>
          <TabButton
            active={tab === "browse"}
            onClick={() => setTab("browse")}
          >
            浏览
          </TabButton>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {tab === "recent" ? (
          <RecentTab currentPath={currentPath} onPick={pickPath} />
        ) : (
          <BrowseTab currentPath={currentPath} onPick={pickPath} />
        )}
      </div>

      <div className="border-t border-line-faint px-4 py-3 shrink-0">
        <div className="text-xs text-ink-muted mb-2">
          或手动输入绝对路径：
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                pickPath(customPath);
              }
            }}
            placeholder="/Users/.../some-repo"
            className="flex-1 px-3 py-1.5 text-sm rounded border border-line-strong bg-surface outline-none focus:border-accent-line font-mono"
          />
          <Button
            variant="primary"
            onClick={() => pickPath(customPath)}
            disabled={!customPath.trim()}
          >
            使用
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-t-md transition-colors ${
        active
          ? "bg-surface text-ink-strong border-x border-t border-line -mb-px"
          : "text-ink-muted hover:text-ink-strong"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Recent tab ──────────────────────────────────────────────────────────

function RecentTab({
  currentPath,
  onPick,
}: {
  currentPath: string | null;
  onPick: (p: string) => void;
}) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/workspaces/recent");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { workspaces } = (await res.json()) as {
          workspaces: WorkspaceEntry[];
        };
        if (!cancelled) {
          setEntries(workspaces);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = filter
    ? entries.filter(
        (e) =>
          e.path.toLowerCase().includes(filter.toLowerCase()) ||
          e.shortName.toLowerCase().includes(filter.toLowerCase()),
      )
    : entries;

  return (
    <>
      <div className="px-4 py-3 border-b border-line-faint shrink-0">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选最近用过的 workspace"
          autoFocus
          className="w-full px-3 py-1.5 text-sm rounded border border-line-strong bg-surface outline-none focus:border-accent-line"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-4 py-6 text-sm text-ink-muted text-center">
            加载中…
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-sm text-danger-ink bg-danger-muted">
            加载失败: {error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="px-4 py-8 text-sm text-ink-muted text-center">
            {filter ? "没有匹配的工作区" : "没有最近用过的工作区"}
          </div>
        )}
        {!loading && !error && (
          <ul>
            {filtered.map((e) => {
              const active = e.path === currentPath;
              return (
                <li key={e.path}>
                  <button
                    onClick={() => onPick(e.path)}
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors border-b border-line-faint last:border-b-0 ${
                      active
                        ? "bg-mode-project-muted"
                        : "hover:bg-surface-muted"
                    }`}
                  >
                    <span aria-hidden className="text-base shrink-0">
                      📁
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">
                        {e.shortName}
                      </span>
                      <span className="block text-xs text-ink-muted truncate font-mono">
                        {prettifyHome(e.path)}
                      </span>
                    </span>
                    {active && (
                      <span className="text-xs text-mode-project-ink shrink-0">
                        当前
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

// ─── Browse tab ──────────────────────────────────────────────────────────

type BrowseEntry = { name: string; path: string };
type BrowseResponse = {
  path: string;
  parent: string | null;
  children: BrowseEntry[];
  truncated: boolean;
  home: string;
};

function BrowseTab({
  currentPath,
  onPick,
}: {
  currentPath: string | null;
  onPick: (p: string) => void;
}) {
  // Where we are right now (server-canonical absolute path).
  const [dir, setDir] = useState<string | null>(null);
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");

  // Initial location: if there's already a workspace selected, jump to it
  // so the user can see siblings + drill nearby. Otherwise let the server
  // default to $HOME.
  useEffect(() => {
    setDir(currentPath ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch whenever dir or showHidden changes. dir=null means "use server
  // default" (home).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFilter("");
    const qs = new URLSearchParams();
    if (dir) qs.set("path", dir);
    if (showHidden) qs.set("showHidden", "true");
    (async () => {
      try {
        const res = await fetch(`/api/workspaces/browse?${qs.toString()}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as BrowseResponse;
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dir, showHidden]);

  // Breadcrumb segments — derived from data.path so server-side path
  // canonicalization (resolve, symlink, trailing slashes) is reflected.
  // Below $HOME we render `~` for the home segment; above, render absolute.
  const segments = useMemo(() => {
    if (!data) return [];
    return buildBreadcrumb(data.path, data.home);
  }, [data]);

  const filteredChildren = useMemo(() => {
    if (!data) return [];
    if (!filter) return data.children;
    const needle = filter.toLowerCase();
    return data.children.filter((c) => c.name.toLowerCase().includes(needle));
  }, [data, filter]);

  return (
    <>
      <div className="px-4 py-2 border-b border-line-faint shrink-0 flex items-center gap-2 overflow-x-auto whitespace-nowrap text-sm">
        {segments.map((seg, i) => (
          <span key={seg.path} className="flex items-center gap-2 shrink-0">
            {i > 0 && (
              <span className="text-ink-faint">/</span>
            )}
            {i === segments.length - 1 ? (
              <span className="font-medium text-ink-strong">
                {seg.label}
              </span>
            ) : (
              <button
                onClick={() => setDir(seg.path)}
                className="text-ink-muted hover:text-ink-strong"
              >
                {seg.label}
              </button>
            )}
          </span>
        ))}
      </div>

      <div className="px-4 py-2 border-b border-line-faint shrink-0 flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选当前目录"
          className="flex-1 px-3 py-1 text-sm rounded border border-line-strong bg-surface outline-none focus:border-accent-line"
        />
        <label className="text-xs text-ink-muted flex items-center gap-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
            className="cursor-pointer"
          />
          隐藏目录
        </label>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-4 py-6 text-sm text-ink-muted text-center">
            加载中…
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-sm text-danger-ink bg-danger-muted">
            {error}
          </div>
        )}
        {!loading && !error && data && (
          <>
            {data.parent && (
              <button
                onClick={() => setDir(data.parent)}
                className="w-full text-left px-4 py-2 flex items-center gap-3 text-sm text-ink-muted hover:bg-surface-muted border-b border-line-faint"
              >
                <span aria-hidden className="text-base shrink-0">
                  ↑
                </span>
                <span className="truncate">上一级</span>
              </button>
            )}
            {filteredChildren.length === 0 ? (
              <div className="px-4 py-8 text-sm text-ink-muted text-center">
                {filter
                  ? "无匹配的子目录"
                  : data.children.length === 0
                    ? "无子目录"
                    : "（已被筛选过滤）"}
              </div>
            ) : (
              <ul>
                {filteredChildren.map((c) => {
                  const active = c.path === currentPath;
                  return (
                    <li key={c.path}>
                      <div
                        className={`w-full flex items-stretch border-b border-line-faint last:border-b-0 ${
                          active ? "bg-mode-project-muted" : ""
                        }`}
                      >
                        <button
                          onClick={() => setDir(c.path)}
                          className="flex-1 min-w-0 text-left px-4 py-2 flex items-center gap-3 hover:bg-surface-muted transition-colors"
                          title="进入此目录"
                        >
                          <span aria-hidden className="text-base shrink-0">
                            📁
                          </span>
                          <span className="block text-sm truncate">
                            {c.name}
                          </span>
                          {active && (
                            <span className="text-xs text-mode-project-ink shrink-0 ml-auto">
                              当前
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => onPick(c.path)}
                          className="px-3 text-xs text-ink-muted hover:text-positive-ink hover:bg-positive-muted border-l border-line-faint transition-colors"
                          title="直接选用此目录"
                        >
                          选用
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {data.truncated && (
              <div className="px-4 py-2 text-xs text-ink-faint italic">
                子目录过多，已截断显示
              </div>
            )}
          </>
        )}
      </div>

      {data && !loading && !error && (
        <div className="px-4 py-2 border-t border-line-faint shrink-0 flex items-center gap-2">
          <span className="text-xs text-ink-muted font-mono truncate flex-1">
            {prettifyHomeWith(data.path, data.home)}
          </span>
          <Button
            variant="primary"
            className="shrink-0"
            onClick={() => onPick(data.path)}
          >
            使用此目录
          </Button>
        </div>
      )}
    </>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────

function prettifyHome(p: string): string {
  if (typeof window === "undefined") return p;
  const m = p.match(/^\/Users\/[^/]+\/(.+)$/);
  return m ? `~/${m[1]}` : p;
}

function prettifyHomeWith(p: string, home: string): string {
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return p;
}

type Segment = { label: string; path: string };

function buildBreadcrumb(p: string, home: string): Segment[] {
  // If we're inside $HOME, collapse the home prefix into a single "~"
  // segment so the breadcrumb doesn't bury the meaningful path under
  // /Users/<user>/.
  const parts: Segment[] = [];
  if (p === home || p.startsWith(home + "/")) {
    parts.push({ label: "~", path: home });
    if (p !== home) {
      const rel = p.slice(home.length + 1);
      const tokens = rel.split("/").filter(Boolean);
      let acc = home;
      for (const t of tokens) {
        acc = acc + "/" + t;
        parts.push({ label: t, path: acc });
      }
    }
    return parts;
  }
  // Outside HOME: full absolute breadcrumb anchored at "/".
  parts.push({ label: "/", path: "/" });
  if (p !== "/") {
    const tokens = p.split("/").filter(Boolean);
    let acc = "";
    for (const t of tokens) {
      acc = acc + "/" + t;
      parts.push({ label: t, path: acc });
    }
  }
  return parts;
}
