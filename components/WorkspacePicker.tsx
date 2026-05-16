"use client";
import { useEffect, useMemo, useRef, useState } from "react";

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
  const cardRef = useRef<HTMLDivElement>(null);

  // Esc to close. Don't intercept on inputs — user may want to clear input
  // text without dismissing the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickPath = (p: string) => {
    const trimmed = p.trim();
    if (!trimmed) return;
    onPick(trimmed);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 dark:bg-black/60 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="w-full max-w-lg bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="border-b border-stone-100 dark:border-stone-800 px-4 py-3 flex items-center gap-3 shrink-0">
          <span aria-hidden className="text-lg">
            📁
          </span>
          <div className="flex-1">
            <div className="text-sm font-medium">选择工作区</div>
            <div className="text-xs text-stone-500 dark:text-stone-400">
              AI 将在该目录下执行工具调用 (cwd)
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 px-1"
          >
            ✕
          </button>
        </div>

        <div className="border-b border-stone-100 dark:border-stone-800 px-2 pt-2 shrink-0">
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

        <div className="border-t border-stone-100 dark:border-stone-800 px-4 py-3 shrink-0">
          <div className="text-xs text-stone-500 dark:text-stone-400 mb-2">
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
              className="flex-1 px-3 py-1.5 text-sm rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 outline-none focus:border-stone-400 dark:focus:border-stone-500 font-mono"
            />
            <button
              onClick={() => pickPath(customPath)}
              disabled={!customPath.trim()}
              className="px-3 py-1.5 text-sm rounded bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              使用
            </button>
          </div>
        </div>
      </div>
    </div>
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
          ? "bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 border-x border-t border-stone-200 dark:border-stone-700 -mb-px"
          : "text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200"
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
      <div className="px-4 py-3 border-b border-stone-100 dark:border-stone-800 shrink-0">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选最近用过的 workspace"
          autoFocus
          className="w-full px-3 py-1.5 text-sm rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 outline-none focus:border-stone-400 dark:focus:border-stone-500"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-4 py-6 text-sm text-stone-500 dark:text-stone-400 text-center">
            加载中…
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40">
            加载失败: {error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="px-4 py-8 text-sm text-stone-500 dark:text-stone-400 text-center">
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
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors border-b border-stone-50 dark:border-stone-800/60 last:border-b-0 ${
                      active
                        ? "bg-amber-50 dark:bg-amber-950/30"
                        : "hover:bg-stone-50 dark:hover:bg-stone-800/50"
                    }`}
                  >
                    <span aria-hidden className="text-base shrink-0">
                      📁
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">
                        {e.shortName}
                      </span>
                      <span className="block text-xs text-stone-500 dark:text-stone-400 truncate font-mono">
                        {prettifyHome(e.path)}
                      </span>
                    </span>
                    {active && (
                      <span className="text-xs text-amber-700 dark:text-amber-300 shrink-0">
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
      <div className="px-4 py-2 border-b border-stone-100 dark:border-stone-800 shrink-0 flex items-center gap-2 overflow-x-auto whitespace-nowrap text-sm">
        {segments.map((seg, i) => (
          <span key={seg.path} className="flex items-center gap-2 shrink-0">
            {i > 0 && (
              <span className="text-stone-300 dark:text-stone-600">/</span>
            )}
            {i === segments.length - 1 ? (
              <span className="font-medium text-stone-900 dark:text-stone-100">
                {seg.label}
              </span>
            ) : (
              <button
                onClick={() => setDir(seg.path)}
                className="text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200"
              >
                {seg.label}
              </button>
            )}
          </span>
        ))}
      </div>

      <div className="px-4 py-2 border-b border-stone-100 dark:border-stone-800 shrink-0 flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选当前目录"
          className="flex-1 px-3 py-1 text-sm rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 outline-none focus:border-stone-400 dark:focus:border-stone-500"
        />
        <label className="text-xs text-stone-500 dark:text-stone-400 flex items-center gap-1 cursor-pointer select-none">
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
          <div className="px-4 py-6 text-sm text-stone-500 dark:text-stone-400 text-center">
            加载中…
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40">
            {error}
          </div>
        )}
        {!loading && !error && data && (
          <>
            {data.parent && (
              <button
                onClick={() => setDir(data.parent)}
                className="w-full text-left px-4 py-2 flex items-center gap-3 text-sm text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/50 border-b border-stone-50 dark:border-stone-800/60"
              >
                <span aria-hidden className="text-base shrink-0">
                  ↑
                </span>
                <span className="truncate">上一级</span>
              </button>
            )}
            {filteredChildren.length === 0 ? (
              <div className="px-4 py-8 text-sm text-stone-500 dark:text-stone-400 text-center">
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
                        className={`w-full flex items-stretch border-b border-stone-50 dark:border-stone-800/60 last:border-b-0 ${
                          active ? "bg-amber-50 dark:bg-amber-950/30" : ""
                        }`}
                      >
                        <button
                          onClick={() => setDir(c.path)}
                          className="flex-1 min-w-0 text-left px-4 py-2 flex items-center gap-3 hover:bg-stone-50 dark:hover:bg-stone-800/50 transition-colors"
                          title="进入此目录"
                        >
                          <span aria-hidden className="text-base shrink-0">
                            📁
                          </span>
                          <span className="block text-sm truncate">
                            {c.name}
                          </span>
                          {active && (
                            <span className="text-xs text-amber-700 dark:text-amber-300 shrink-0 ml-auto">
                              当前
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => onPick(c.path)}
                          className="px-3 text-xs text-stone-500 dark:text-stone-400 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 border-l border-stone-100 dark:border-stone-800 transition-colors"
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
              <div className="px-4 py-2 text-xs text-stone-400 dark:text-stone-500 italic">
                子目录过多，已截断显示
              </div>
            )}
          </>
        )}
      </div>

      {data && !loading && !error && (
        <div className="px-4 py-2 border-t border-stone-100 dark:border-stone-800 shrink-0 flex items-center gap-2">
          <span className="text-xs text-stone-500 dark:text-stone-400 font-mono truncate flex-1">
            {prettifyHomeWith(data.path, data.home)}
          </span>
          <button
            onClick={() => onPick(data.path)}
            className="px-3 py-1.5 text-sm rounded bg-emerald-600 hover:bg-emerald-700 text-white shrink-0"
          >
            使用此目录
          </button>
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
