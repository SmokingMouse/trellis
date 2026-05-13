"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";

// Stage 16: cross-session full-text search modal. ⌘P (Cmd/Ctrl+P) opens
// it from anywhere; the global keydown listener is owned by this
// component so the rest of the app doesn't have to know about its state.
// trigram tokenizer means queries < 3 chars match nothing — we render a
// "type more" hint and skip the round-trip below that threshold.

const MIN_QUERY = 3;
const DEBOUNCE_MS = 200;

type Hit = {
  sourceKind: "node_question" | "node_response" | "node_reference" | "note";
  sourceId: string;
  snippet: string;
  matchText: string;
};

type Result = {
  sessionId: string;
  sessionTitle: string;
  sessionMode: string;
  sessionWorkspacePath: string | null;
  hits: Hit[];
};

type FacetKey = "all" | "chat" | "workspace" | "project";

export function SearchModal() {
  const open = useSessionStore((s) => s.searchOpen);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  // Global ⌘P / Ctrl+P listener. We intercept the browser's print
  // shortcut — users can still print via the browser menu. Both the
  // keydown and the Header 🔍 button (mobile) toggle the same
  // store-backed open state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "p" && e.key !== "P") return;
      e.preventDefault();
      setSearchOpen(!useSessionStore.getState().searchOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);

  if (!open) return null;
  return <SearchModalBody onClose={() => setSearchOpen(false)} />;
}

function SearchModalBody({ onClose }: { onClose: () => void }) {
  const jumpToSearchHit = useSessionStore((s) => s.jumpToSearchHit);
  const jumpToNoteSource = useSessionStore((s) => s.jumpToNoteSource);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [facet, setFacet] = useState<FacetKey>("all");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce 200ms; below MIN_QUERY chars short-circuits to "" so the
  // server isn't pinged and the empty state explains why.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setDebounced("");
      return;
    }
    const t = window.setTimeout(() => setDebounced(trimmed), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!debounced) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(debounced)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setResults((data.results as Result[]) ?? []);
        setCursor(0);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const filtered = useMemo(() => {
    if (facet === "all") return results;
    return results.filter((r) => r.sessionMode === facet);
  }, [results, facet]);

  // Flatten to a (resultIdx, hitIdx) cursor list for keyboard navigation.
  // Building this once per render is fine — at most ~80 entries.
  const flatHits = useMemo(() => {
    const list: { resultIdx: number; hitIdx: number }[] = [];
    filtered.forEach((r, ri) => {
      r.hits.forEach((_, hi) => list.push({ resultIdx: ri, hitIdx: hi }));
    });
    return list;
  }, [filtered]);

  const onJump = (r: Result, h: Hit) => {
    if (h.sourceKind === "note") {
      // Jump to the note's source node + pulse the original quote.
      // This is the same path the NotesDrawer uses.
      jumpToNoteSource(h.sourceId);
      onClose();
      return;
    }
    const matchKind: "question" | "response" | "reference" =
      h.sourceKind === "node_question"
        ? "question"
        : h.sourceKind === "node_response"
          ? "response"
          : "reference";
    void jumpToSearchHit({
      sessionId: r.sessionId,
      nodeId: h.sourceId,
      matchText: h.matchText,
      matchKind,
    });
    onClose();
  };

  // Keyboard nav: ↑↓ moves the cursor across the flat list, ⏎ activates.
  // Esc closes; handled in the input onKeyDown so it can't double-fire
  // with the global keydown listener (which doesn't watch Esc).
  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatHits.length) setCursor((c) => (c + 1) % flatHits.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatHits.length) {
        setCursor((c) => (c - 1 + flatHits.length) % flatHits.length);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = flatHits[cursor];
      if (!target) return;
      const r = filtered[target.resultIdx];
      const h = r?.hits[target.hitIdx];
      if (r && h) onJump(r, h);
    }
  };

  // Scroll selected row into view when cursor changes. Use data-cursor
  // attribute on the row + scrollIntoView({block:"nearest"}).
  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-cursor="${cursor}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const tooShort = query.trim().length > 0 && query.trim().length < MIN_QUERY;
  const empty =
    !loading && debounced.length > 0 && filtered.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-900/40 dark:bg-black/60 flex items-start justify-center pt-[10vh] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-stone-900 rounded-xl shadow-2xl overflow-hidden border border-transparent dark:border-stone-800 flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-100 dark:border-stone-800">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-stone-400 dark:text-stone-500 shrink-0"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="搜索所有对话、笔记、参考材料…"
            className="flex-1 bg-transparent outline-none text-[14px] text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 shrink-0">
            Esc
          </kbd>
        </div>

        {/* Facet chips */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-[12px]">
          {(["all", "chat", "workspace", "project"] as FacetKey[]).map(
            (f) => (
              <button
                key={f}
                onClick={() => setFacet(f)}
                className={`px-2 py-0.5 rounded-full transition-colors ${
                  facet === f
                    ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                    : "text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
                }`}
              >
                {facetLabel(f)}
              </button>
            ),
          )}
          <div className="flex-1" />
          {loading && (
            <span className="text-[11px] text-stone-400 dark:text-stone-500 italic">
              搜索中…
            </span>
          )}
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto"
        >
          {tooShort && (
            <div className="px-4 py-6 text-[12px] text-stone-400 dark:text-stone-500 italic">
              至少输入 {MIN_QUERY} 个字符（trigram 分词器限制）
            </div>
          )}
          {!tooShort && !debounced && (
            <div className="px-4 py-6 text-[12px] text-stone-400 dark:text-stone-500 italic">
              输入关键词搜索所有 session、笔记、参考材料。⌘P 打开 / 关闭。
            </div>
          )}
          {empty && (
            <div className="px-4 py-6 text-[12px] text-stone-400 dark:text-stone-500 italic">
              没有结果
            </div>
          )}
          {filtered.map((r, ri) => (
            <div
              key={r.sessionId}
              className="border-b border-stone-100 dark:border-stone-800 last:border-b-0"
            >
              <div className="px-4 pt-2.5 pb-1.5 flex items-center gap-2 text-[11px]">
                <span className="text-stone-700 dark:text-stone-200 font-medium truncate">
                  {r.sessionTitle}
                </span>
                <ModeChip mode={r.sessionMode} />
                {r.sessionWorkspacePath && (
                  <span className="text-stone-400 dark:text-stone-500 truncate">
                    {basename(r.sessionWorkspacePath)}
                  </span>
                )}
              </div>
              {r.hits.map((h, hi) => {
                const flatIdx = flatHits.findIndex(
                  (x) => x.resultIdx === ri && x.hitIdx === hi,
                );
                const active = flatIdx === cursor;
                return (
                  <button
                    key={`${h.sourceKind}:${h.sourceId}:${hi}`}
                    data-cursor={flatIdx}
                    onMouseEnter={() => setCursor(flatIdx)}
                    onClick={() => onJump(r, h)}
                    className={`w-full text-left px-4 py-2 flex items-start gap-2 transition-colors ${
                      active
                        ? "bg-indigo-50/70 dark:bg-indigo-950/40"
                        : "hover:bg-stone-50 dark:hover:bg-stone-800/60"
                    }`}
                  >
                    <span className="shrink-0 mt-0.5">
                      {hitIcon(h.sourceKind)}
                    </span>
                    <span
                      className="text-[12.5px] text-stone-700 dark:text-stone-300 leading-relaxed line-clamp-2"
                      // FTS5 already escapes content; <mark> tags are
                      // the only HTML we injected. Trusted.
                      dangerouslySetInnerHTML={{ __html: h.snippet }}
                    />
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hints */}
        <div className="px-4 py-2 border-t border-stone-100 dark:border-stone-800 text-[11px] text-stone-400 dark:text-stone-500 flex items-center gap-3">
          <span>↑↓ 选择</span>
          <span>⏎ 跳转</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}

function ModeChip({ mode }: { mode: string }) {
  const cls =
    mode === "project"
      ? "bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300"
      : mode === "workspace"
        ? "bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
        : "bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-300";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9.5px] uppercase ${cls}`}>
      {mode}
    </span>
  );
}

function hitIcon(kind: Hit["sourceKind"]): React.ReactNode {
  switch (kind) {
    case "node_question":
      return <span className="text-indigo-500 dark:text-indigo-400">💬</span>;
    case "node_response":
      return <span className="text-emerald-500 dark:text-emerald-400">💭</span>;
    case "node_reference":
      return <span className="text-amber-500 dark:text-amber-400">📄</span>;
    case "note":
      return <span className="text-fuchsia-500 dark:text-fuchsia-400">📝</span>;
  }
}

function facetLabel(f: FacetKey): string {
  switch (f) {
    case "all":
      return "全部";
    case "chat":
      return "Chat";
    case "workspace":
      return "Workspace";
    case "project":
      return "Project";
  }
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}
