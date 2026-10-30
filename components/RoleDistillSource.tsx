"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, MessageSquare, Search } from "lucide-react";
import { Button, ErrorCallout, Icon, Input, PixelLoader, cn } from "@/components/ui";
import type { DistillSource, RoleDraft } from "@/lib/role-follow";

// 新建弹窗第三个起点「从会话提炼」（原型 09-roles.html 新建弹窗：来源会话 + 提炼出的草稿）。
//   1. 选来源会话：最近 50 个普通会话，可按标题搜（GET /api/roles/distill/sources）；
//   2. 选中即提炼：POST /api/roles/distill，一次模型调用，十几秒到一两分钟；
//   3. 拿到草稿交给弹窗预填表单，这里显示「提炼出的草稿」摘要（带走几条记忆）。
// 选中后来源收成一行（原型的 field + chevron），点它重新挑。

const SEARCH_DEBOUNCE_MS = 200;

function sourceMeta(s: Pick<DistillSource, "nodeCount" | "workspace">): string {
  return [`${s.nodeCount} 节`, s.workspace].filter(Boolean).join(" · ");
}

export function RoleDistillSource({
  id,
  draft,
  onDraft,
  onBusyChange,
}: {
  /** 搜索框的 id（给外层 label 的 htmlFor） */
  id: string;
  draft: RoleDraft | null;
  onDraft: (draft: RoleDraft) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<DistillSource[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [picked, setPicked] = useState<DistillSource | null>(null);
  const [picking, setPicking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!picking) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      fetch(`/api/roles/distill/sources?q=${encodeURIComponent(query.trim())}`, { signal: ctrl.signal, cache: "no-store" })
        .then(async (r) => {
          const d = (await r.json().catch(() => ({}))) as { sources?: DistillSource[]; error?: string };
          if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
          setSources(d.sources ?? []);
          setListError(null);
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === "AbortError") return;
          setListError(e instanceof Error ? e.message : String(e));
        });
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [query, picking]);

  const run = async (s: DistillSource) => {
    const req = ++reqRef.current;
    setPicked(s);
    setPicking(false);
    setBusy(true);
    setError(null);
    onBusyChange(true);
    try {
      const r = await fetch("/api/roles/distill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: s.sessionId }),
      });
      const d = (await r.json().catch(() => ({}))) as { draft?: RoleDraft; error?: string };
      if (req !== reqRef.current) return;
      if (!r.ok || !d.draft) throw new Error(d.error ?? `HTTP ${r.status}`);
      onDraft(d.draft);
    } catch (e) {
      if (req === reqRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (req === reqRef.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  };

  if (picking || !picked) {
    return (
      <div className="flex flex-col gap-2" data-distill-picker>
        <div className="relative">
          <Icon icon={Search} size="sm" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <Input
            id={id}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜会话标题"
            className="pl-8"
            autoComplete="off"
            aria-label="搜来源会话"
          />
        </div>
        {listError ? (
          <ErrorCallout compact error={listError} title="会话列表加载失败" />
        ) : (
          <div
            role="listbox"
            aria-label="来源会话"
            className="flex max-h-60 flex-col divide-y divide-line overflow-y-auto overscroll-contain rounded-card bg-surface-canvas shadow-hairline"
          >
            {sources === null ? (
              <div className="flex items-center gap-2 px-3 py-2.5 text-label text-ink-muted">
                <PixelLoader size="sm" label="加载中" /> 正在拉最近的会话…
              </div>
            ) : sources.length === 0 ? (
              <div className="px-3 py-2.5 text-label text-ink-muted">
                {query.trim() ? "没有标题匹配的会话" : "还没有聊过的会话"}
              </div>
            ) : (
              sources.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  role="option"
                  aria-selected={picked?.sessionId === s.sessionId}
                  data-distill-source={s.sessionId}
                  onClick={() => void run(s)}
                  className={cn(
                    "flex min-h-10 items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100 hover:bg-surface-hover max-md:min-h-11",
                    picked?.sessionId === s.sessionId && "bg-surface-hover",
                  )}
                >
                  <Icon icon={MessageSquare} size="sm" className="shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-ui text-ink">{s.title}</span>
                  <span className="shrink-0 text-label tabular-nums text-ink-faint">{sourceMeta(s)}</span>
                </button>
              ))
            )}
          </div>
        )}
        {picked && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setPicking(false)}>
            还用「{picked.title}」
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        id={id}
        type="button"
        data-distill-picked={picked.sessionId}
        onClick={() => setPicking(true)}
        disabled={busy}
        title="换一段会话"
        className="flex min-h-9 w-full items-center gap-2 rounded-field bg-surface-raised px-2.5 py-1.5 text-left shadow-hairline transition-colors duration-100 hover:bg-surface-hover disabled:cursor-progress max-md:min-h-11"
      >
        <Icon icon={MessageSquare} size="sm" className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-ui text-ink">{picked.title}</span>
        <span className="shrink-0 text-label tabular-nums text-ink-faint">{sourceMeta(picked)}</span>
        <Icon icon={ChevronRight} size="sm" className="shrink-0 text-ink-faint" />
      </button>
      {busy ? (
        <div role="status" className="flex items-center gap-2 rounded-card bg-surface-muted px-3 py-2.5 text-label text-ink-muted shadow-hairline">
          <PixelLoader size="sm" label="提炼中" />
          正在读这段对话，提炼人设和记忆…通常要半分钟到一两分钟
        </div>
      ) : error ? (
        <ErrorCallout compact error={error} title="没能提炼出草稿" onRetry={() => void run(picked)} />
      ) : draft ? (
        <DraftSummary draft={draft} />
      ) : null}
    </div>
  );
}

function DraftSummary({ draft }: { draft: RoleDraft }) {
  const n = draft.memories.length;
  const examples = draft.memories.slice(0, 2).map((m) => `「${m.description || m.name}」`);
  return (
    <div data-distill-draft className="rounded-card bg-surface-muted px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted shadow-hairline">
      <b className="font-semibold text-ink">提炼出的草稿</b>（下面都能改）：{draft.intro || draft.name}
      {n > 0 ? (
        <>
          ；从这段对话里带走 {n} 条记忆{examples.length ? `，比如${examples.join("")}` : ""}，创建时一并写进它的记忆。
        </>
      ) : (
        "；这段对话里没有值得长期记住的事，记忆从空白开始。"
      )}
      {draft.source.truncated && <span className="block text-ink-faint">会话较长，只读了最近的一部分轮次。</span>}
    </div>
  );
}
