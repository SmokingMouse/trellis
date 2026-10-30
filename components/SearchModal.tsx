"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  FileText,
  FolderGit2,
  MessageSquare,
  NotebookPen,
  Search,
  Server,
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
  SearchSnippet,
  SegmentedControl,
  Spinner,
  cn,
} from "@/components/ui";
import { modeStyle } from "@/lib/mode-style";
import { RoleAvatar } from "@/components/ui/Avatar";
import type { RoleBadge } from "@/lib/role-follow";
import { goHref } from "@/lib/gw-client";
import { fanOut, groupSearch, sessionPath, type SearchGroup } from "@/lib/hub-fanout";
import { useHubNodes, useOtherNodes } from "@/hooks/useHubNodes";

// Stage 16: cross-session full-text search modal. ⌘P (Cmd/Ctrl+P) opens
// it from anywhere; the global keydown listener is owned by this
// component so the rest of the app doesn't have to know about its state.
//
// 1 个字起搜：后端 search_index 是 FTS5 trigram（三字滑窗），≥3 字走 MATCH；
// 1–2 字（「向量」「AI」「钱」）由 lib/server/repo.ts 的 searchAll 回退到参数化
// LIKE，返回结构一致。
//
// 多机（经 hub 且有远端机器）时多一个「本机 / 所有机器」范围：所有机器 = 本机 /api/search
// 先出，其他在线机器经 /__gw/via/<node>/api/search 并发补上（lib/hub-fanout，每台独立超时、
// 失败隔离），结果按机器分组。远端命中点击整页切到那台机器的会话（/__gw/go/<node>/?session=…）。

const MIN_QUERY = 1;
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
  /** 'role' = 角色固定会话（带 role）；'group' = 群聊。老版本远端机器不给。 */
  sessionKind?: string;
  role?: RoleBadge | null;
};

type FacetKey = "all" | "chat" | "project";
type ScopeKey = "local" | "nodes";

// 远端每台只要前 40 条：分组展示，一台不该挤掉别的机器。
const REMOTE_LIMIT = 40;

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
  // 远端结果连同它对应的查询键存：键对不上（换了词 / 切回本机）就当没有，不必在 effect 里清空。
  const [remote, setRemote] = useState<{ key: string; groups: SearchGroup<Result>[] } | null>(null);
  const [scope, setScope] = useState<ScopeKey>("local");
  const hubNodes = useHubNodes();
  const others = useOtherNodes();
  const multi = others.length > 0;
  const allNodes = multi && scope === "nodes";
  const localName = hubNodes?.find((n) => n.current)?.name ?? "本机";
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

  // Debounce 200ms; an empty query short-circuits to "" so the server
  // isn't pinged.
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

  // 「所有机器」：其他在线机器并发搜，和本机那一路互不等待。
  const othersKey = others.map((n) => `${n.name}:${n.online ? 1 : 0}`).join(",");
  const othersRef = useRef(others);
  useEffect(() => { othersRef.current = others; });
  const remoteKey = debounced && allNodes ? `${debounced}\n${othersKey}\n${retryKey}` : "";
  useEffect(() => {
    if (!remoteKey) return;
    const controller = new AbortController();
    void fanOut<{ results?: Result[] }>(
      othersRef.current,
      `/api/search?q=${encodeURIComponent(debounced)}&limit=${REMOTE_LIMIT}`,
      { signal: controller.signal },
    ).then((res) => {
      if (!controller.signal.aborted) setRemote({ key: remoteKey, groups: groupSearch<Result>(null, res) });
    });
    return () => controller.abort();
  }, [remoteKey, debounced]);
  const remoteLoading = !!remoteKey && remote?.key !== remoteKey;
  const remoteGroups = remoteKey && remote?.key === remoteKey ? remote.groups : null;

  // 分组：本机一组（单机 / 只搜本机时就这一组、不画机器标题）+ 远端各机器。facet 在组内筛。
  const groups = useMemo(() => {
    const local = { node: localName, results };
    const all = [...groupSearch<Result>(local, []), ...(remoteGroups ?? [])];
    if (facet === "all") return all;
    return all.map((g) => (g.status === "ok" ? { ...g, results: g.results.filter((r) => r.sessionMode === facet) } : g));
  }, [results, remoteGroups, localName, facet]);

  // Flatten to a (group, result, hit) cursor list for keyboard navigation.
  // Building this once per render is fine — at most a few hundred entries.
  const flatHits = useMemo(() => {
    const list: { groupIdx: number; resultIdx: number; hitIdx: number }[] = [];
    groups.forEach((g, gi) => {
      if (g.status !== "ok") return;
      g.results.forEach((r, ri) => {
        r.hits.forEach((_, hi) => list.push({ groupIdx: gi, resultIdx: ri, hitIdx: hi }));
      });
    });
    return list;
  }, [groups]);
  const resultCount = groups.reduce((n, g) => n + (g.status === "ok" ? g.results.length : 0), 0);

  const onJumpIn = (g: SearchGroup<Result>, r: Result, h: Hit) => {
    if (g.local) return onJump(r, h);
    // 远端：整页切机器。笔记命中只能定位到会话（笔记 id 不是节点 id）。
    window.location.assign(goHref(g.node, sessionPath(r.sessionId, h.sourceKind === "note" ? null : h.sourceId)));
  };

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
      const g = groups[target.groupIdx];
      const r = g?.status === "ok" ? g.results[target.resultIdx] : undefined;
      const h = r?.hits[target.hitIdx];
      if (g && r && h) onJumpIn(g, r, h);
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

  const empty =
    !loading && !remoteLoading && !error && debounced.length > 0 && resultCount === 0;

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
      // 命令面板形态（原型 .palette）：桌面贴在视口上方 14vh 处而不是正中，结果多了只往下长
      panelClassName="flex flex-col max-h-[80vh] md:self-start md:mt-[14vh] md:max-h-[min(80vh,560px)]"
    >
      {/* Input */}
      <div className="flex items-center gap-2.5 px-4 min-h-[50px] border-b border-line">
        <Icon icon={Search} className="shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="搜索会话里的提问、回复、参考材料和笔记…"
          aria-label="搜索"
          className="flex-1 min-w-0 bg-transparent outline-none text-[15px] text-ink placeholder:text-ink-faint"
        />
        {loading || remoteLoading ? <Spinner size="sm" label="搜索中" /> : null}
        <Kbd>Esc</Kbd>
      </div>

      {/* Facets */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <SegmentedControl
          size="sm"
          aria-label="按会话类型筛选"
          value={facet}
          onValueChange={setFacet}
          options={facetOptions}
        />
        {multi && (
          <SegmentedControl<ScopeKey>
            size="sm"
            aria-label="搜索范围"
            className="ml-auto"
            value={scope}
            onValueChange={(v) => {
              setScope(v);
              setCursor(0);
            }}
            options={[
              { value: "local", label: "本机" },
              { value: "nodes", label: "所有机器" },
            ]}
          />
        )}
      </div>

      {/* Results */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
        {!debounced && (
          <EmptyState
            compact
            icon={Search}
            title="搜索所有会话"
            description="会话里的提问、回复、参考材料和笔记都能搜到。"
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
        {groups.map((g, gi) => {
          if (g.status !== "ok") {
            return (
              <div key={`off:${g.node}`} data-search-node={g.node} className="pb-1">
                <NodeHeading name={g.node} />
                <div className="px-2.5 py-1.5 text-label text-ink-faint opacity-70">
                  {g.status === "offline" ? "这台机器离线，没搜到不代表没有" : `暂时连不上${g.error ? `（${g.error}）` : ""}`}
                </div>
              </div>
            );
          }
          if (g.results.length === 0) return null;
          return (
            <div key={`n:${g.node}`} data-search-node={allNodes ? g.node : undefined}>
              {allNodes && <NodeHeading name={g.node} local={g.local} />}
              {g.results.map((r, ri) => (
          <div key={r.sessionId} className="pb-1">
            <SessionHeading result={r} />
            {r.hits.map((h, hi) => {
              const flatIdx = flatHits.findIndex(
                (x) => x.groupIdx === gi && x.resultIdx === ri && x.hitIdx === hi,
              );
              const active = flatIdx === cursor;
              const kind = HIT_KIND[h.sourceKind];
              return (
                <button
                  key={`${h.sourceKind}:${h.sourceId}:${hi}`}
                  type="button"
                  data-cursor={flatIdx}
                  onMouseEnter={() => setCursor(flatIdx)}
                  onClick={() => onJumpIn(g, r, h)}
                  aria-label={g.local ? undefined : `${g.node} 上的${kind.label}：${h.matchText || r.sessionTitle}，切到这台机器打开`}
                  // 原型 .pal-row：高亮行 = hover 底 + 行尾 ↵ 提示；光标跟着指针走（onMouseEnter）
                  className={cn(
                    "press-row w-full text-left px-2.5 py-2 min-h-[38px] rounded-field flex items-start gap-2.5 transition-colors duration-100",
                    active ? "bg-surface-hover" : "hover:bg-surface-hover",
                  )}
                >
                  <Icon icon={kind.icon} size="sm" className="mt-0.5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] text-ink leading-relaxed line-clamp-2">
                      <SearchSnippet html={h.snippet} />
                    </span>
                    <span className="block text-label text-ink-faint">{kind.label}</span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 shrink-0 font-mono text-nano text-ink-faint transition-opacity duration-100 max-md:hidden",
                      active ? "opacity-100" : "opacity-0",
                    )}
                  >
                    ↵
                  </span>
                </button>
              );
            })}
          </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Footer hints */}
      <div className="px-3.5 py-2 border-t border-line bg-surface-muted/60 dark:bg-surface text-[11.5px] text-ink-faint flex items-center gap-3.5">
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

// 「所有机器」范围下的机器分组头：比会话组头再高一级（墨色小字 + 机器图标 + 下方发丝线）。
function NodeHeading({ name, local = false }: { name: string; local?: boolean }) {
  return (
    <div className="mx-1 mt-1.5 flex items-center gap-1.5 border-b border-line-faint px-1.5 pb-1 pt-1 text-[12px] font-semibold text-ink-muted">
      <Icon icon={Server} size="sm" className="size-3.5 shrink-0 text-ink-faint" />
      <span className="truncate">{name}</span>
      {local && <span className="shrink-0 font-normal text-ink-faint">本机</span>}
    </div>
  );
}

function SessionHeading({ result: r }: { result: Result }) {
  const st = modeStyle(r.sessionMode);
  const isProject = r.sessionMode === "project";
  return (
    // 原型 .pal-list .gh：组头是小号 ink-faint，结果行才是主角
    <div className="px-2.5 pt-2 pb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-faint min-w-0">
      {r.role ? (
        // 角色固定会话：头像 + 角色名（一条会话装着它全部话题，标题只是首问）
        <>
          <RoleAvatar role={r.role} size="xs" className="size-4 text-[9px]" />
          <span data-search-role={r.role.id} className="shrink-0 text-ink">{r.role.name}</span>
        </>
      ) : (
        <Icon icon={isProject ? FolderGit2 : MessageSquare} size="sm" className="size-3 shrink-0 text-ink-faint" />
      )}
      {r.sessionKind === "group" && <span className="shrink-0 text-ink">群聊</span>}
      <span className="text-ink-muted truncate">{r.sessionTitle}</span>
      <span className={cn("shrink-0", st.text)}>{st.label}</span>
      {r.sessionWorkspacePath && (
        <span className="text-ink-faint truncate">{basename(r.sessionWorkspacePath)}</span>
      )}
    </div>
  );
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
