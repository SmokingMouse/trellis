"use client";
import { useEffect, useState, useRef } from "react";

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

export function WorkspacePicker({ currentPath, onPick, onClose }: Props) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState("");
  const [filter, setFilter] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);

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

  // Esc to close. Don't intercept on the custom-path input itself —
  // user may want to clear it without dismissing the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const tag = (document.activeElement?.tagName ?? "").toLowerCase();
        if (tag === "input") return;
        onClose();
      }
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

  const filtered = filter
    ? entries.filter(
        (e) =>
          e.path.toLowerCase().includes(filter.toLowerCase()) ||
          e.shortName.toLowerCase().includes(filter.toLowerCase()),
      )
    : entries;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 dark:bg-black/60 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="w-full max-w-lg bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="border-b border-stone-100 dark:border-stone-800 px-4 py-3 flex items-center gap-3">
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

        <div className="px-4 py-3 border-b border-stone-100 dark:border-stone-800">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选 / 搜索"
            autoFocus
            className="w-full px-3 py-1.5 text-sm rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 outline-none focus:border-stone-400 dark:focus:border-stone-500"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto">
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
                      onClick={() => pickPath(e.path)}
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

        <div className="border-t border-stone-100 dark:border-stone-800 px-4 py-3">
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

function prettifyHome(p: string): string {
  if (typeof window === "undefined") return p;
  // Best-effort: we don't know the home dir client-side, but the API
  // already returns absolute paths. Just trim a leading /Users/<u>/ for
  // brevity. Server-side shortening would need to round-trip home.
  const m = p.match(/^\/Users\/[^/]+\/(.+)$/);
  return m ? `~/${m[1]}` : p;
}
