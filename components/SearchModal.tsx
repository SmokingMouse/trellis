"use client";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  FileText,
  FolderGit2,
  MessageSquare,
  NotebookPen,
  Search,
  SearchX,
  User,
  type LucideIcon,
} from "lucide-react";
import { useSessionStore } from "@/stores/sessionStore";
import {
  EmptyState,
  ErrorCallout,
  Icon,
  Kbd,
  Modal,
  SegmentedControl,
  Spinner,
  cn,
} from "@/components/ui";
import { modeStyle } from "@/lib/mode-style";

// Stage 16: cross-session full-text search modal. ⌘P (Cmd/Ctrl+P) opens
// it from anywhere; the global keydown listener is owned by this
// component so the rest of the app doesn't have to know about its state.
//
// 最短 3 个字：后端 search_index 是 FTS5 trigram 分词（三字滑窗），短于 3 字的
// MATCH 必然零命中，lib/server/repo.ts 的 buildFtsQuery 也直接短路返回 []。
// 所以 1–2 个字（「向量」「AI」）在这里给提示、不发请求；后端若补上 <3 字的
// LIKE 回退，把 MIN_QUERY 调到 1 即可。

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

type FacetKey = "all" | "chat" | "project";

export function SearchModal() {
  const open = useSessionStore((s) => s.searchOpen);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  // Global ⌘P / Ctrl+P listener. We intercept the browser's print
  // shortcut — users can still print via the browser menu. Both the
  // keydown and the Header search button (mobile) toggle the same
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
  const [error, setError] = useState<unknown>(null);
  const [retryKey, setRetryKey] = useState(0);
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
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(debounced)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setResults((data.results as Result[]) ?? []);
        setError(null);
        setCursor(0);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setResults([]);
        setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, retryKey]);

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
      if (e.nativeEvent.isComposing) return;
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

  const trimmedLen = query.trim().length;
  const tooShort = trimmedLen > 0 && trimmedLen < MIN_QUERY;
  const empty =
    !loading && !error && debounced.length > 0 && filtered.length === 0;

  const facetOptions = (["all", "chat", "project"] as FacetKey[]).map((f) => ({
    value: f,
    label: facetLabel(f),
  }));

  return (
    // closeOnEsc={false}：Esc 由输入框的 onInputKey 自管（避免与键盘导航双触发）。
    <Modal
      onClose={onClose}
      size="lg"
      closeOnEsc={false}
      title="搜索"
      panelClassName="flex flex-col max-h-[80vh]"
    >
      {/* Input */}
      <div className="flex items-center gap-2.5 px-4 min-h-12 border-b border-line">
        <Icon icon={Search} className="text-ink-faint" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="搜索会话里的提问、回复、参考材料和笔记…"
          aria-label="搜索"
          className="flex-1 min-w-0 bg-transparent outline-none text-body text-ink-strong placeholder:text-ink-faint"
        />
        {loading ? <Spinner size="sm" label="搜索中" /> : null}
        <Kbd>Esc</Kbd>
      </div>

      {/* Facets */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line-faint">
        <SegmentedControl
          size="sm"
          aria-label="按会话类型筛选"
          value={facet}
          onValueChange={setFacet}
          options={facetOptions}
        />
      </div>

      {/* Results */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
        {tooShort && (
          <EmptyState
            compact
            icon={Search}
            title={`再输入 ${MIN_QUERY - trimmedLen} 个字就能搜`}
            description={`全文搜索至少需要 ${MIN_QUERY} 个字（中英文都按字数算）。两个字的词可以带上前后一个字，比如「向量库」。`}
          />
        )}
        {!tooShort && !debounced && (
          <EmptyState
            compact
            icon={Search}
            title="搜索所有会话"
            description="会话里的提问、回复、参考材料和笔记都能搜到，至少输入 3 个字。"
          />
        )}
        {!!error && debounced && (
          <div className="px-3 py-2">
            <ErrorCallout
              compact
              error={error}
              title="搜索失败"
              onRetry={() => setRetryKey((k) => k + 1)}
            />
          </div>
        )}
        {empty && (
          <EmptyState
            compact
            icon={SearchX}
            title={`没有找到「${debounced}」`}
            description={
              facet === "all"
                ? "换个说法试试；搜索按原文字面匹配。"
                : "当前只看一种会话类型，切到「全部」看看。"
            }
          />
        )}
        {filtered.map((r, ri) => (
          <div key={r.sessionId} className="px-1.5 pb-1">
            <SessionHeading result={r} />
            {r.hits.map((h, hi) => {
              const flatIdx = flatHits.findIndex(
                (x) => x.resultIdx === ri && x.hitIdx === hi,
              );
              const active = flatIdx === cursor;
              const kind = HIT_KIND[h.sourceKind];
              return (
                <button
                  key={`${h.sourceKind}:${h.sourceId}:${hi}`}
                  type="button"
                  data-cursor={flatIdx}
                  onMouseEnter={() => setCursor(flatIdx)}
                  onClick={() => onJump(r, h)}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 rounded-field flex items-start gap-2.5 transition-colors duration-100",
                    active ? "bg-surface-hover" : "hover:bg-surface-hover",
                  )}
                >
                  <Icon icon={kind.icon} className="mt-0.5 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui text-ink leading-relaxed line-clamp-2">
                      <Snippet html={h.snippet} />
                    </span>
                    <span className="block text-label text-ink-faint">{kind.label}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Footer hints */}
      <div className="px-4 py-2 border-t border-line-faint text-label text-ink-faint flex items-center gap-4">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> 选择
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↩</Kbd> 跳转
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> 关闭
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd keys={["⌘", "P"]} /> 打开 / 关闭
        </span>
      </div>
    </Modal>
  );
}

function SessionHeading({ result: r }: { result: Result }) {
  const st = modeStyle(r.sessionMode);
  const isProject = r.sessionMode === "project";
  return (
    <div className="px-2.5 pt-2.5 pb-1 flex items-center gap-2 text-label min-w-0">
      <Icon icon={isProject ? FolderGit2 : MessageSquare} size="sm" className="text-ink-faint" />
      <span className="text-ink font-medium truncate">{r.sessionTitle}</span>
      <span className={cn("shrink-0", st.text)}>{st.label}</span>
      {r.sessionWorkspacePath && (
        <span className="text-ink-faint truncate">{basename(r.sessionWorkspacePath)}</span>
      )}
    </div>
  );
}

// 片段来自 FTS5 snippet()：它只在命中处插 <mark>，**不转义原文**——索引里存的是
// 原始提问 / 回复文本，回复里的 HTML 会原样出现。所以这里不走
// dangerouslySetInnerHTML，而是只认 <mark> / </mark> 两个标记，其余一律当文本。
function Snippet({ html }: { html: string }) {
  const parts: ReactNode[] = [];
  let marked = false;
  html.split(/(<mark>|<\/mark>)/).forEach((seg, i) => {
    if (seg === "<mark>") {
      marked = true;
      return;
    }
    if (seg === "</mark>") {
      marked = false;
      return;
    }
    if (!seg) return;
    parts.push(
      marked ? (
        <mark key={i} className="rounded-sm bg-accent-muted px-0.5 text-accent-ink">
          {seg}
        </mark>
      ) : (
        <Fragment key={i}>{seg}</Fragment>
      ),
    );
  });
  return <>{parts}</>;
}

const HIT_KIND: Record<Hit["sourceKind"], { icon: LucideIcon; label: string }> = {
  node_question: { icon: User, label: "提问" },
  node_response: { icon: Bot, label: "回复" },
  node_reference: { icon: FileText, label: "参考材料" },
  note: { icon: NotebookPen, label: "笔记" },
};

function facetLabel(f: FacetKey): string {
  if (f === "all") return "全部";
  return modeStyle(f).label;
}

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}
