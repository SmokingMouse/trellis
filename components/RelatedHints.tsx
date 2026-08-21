"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";

// 体验 A：发问时相似检测的旁路提示条（挂在首屏 QuestionInput 输入卡下方）。
// ⌘P 搜索是 pull 式 —— 得先想起来「我可能聊过」；这条是 push 式：正要新开
// 树的那一刻拿草稿去查一把，聊过就提示「去原树续聊 or 继续新开」。纪律：
//  - 不打断输入流：无焦点抢占、无弹窗；✕ 后本次草稿内不再出现（清空输入复位）
//  - 宁漏报不误报：服务端 findRelated 有 term 覆盖度门槛，这里再要求 ≥6 字才查
//  - "/"、"$" 开头是命令/技能面板语境，跳过
type RelatedHit = {
  sessionId: string;
  sessionTitle: string;
  sessionMode: string;
  sessionWorkspacePath: string | null;
  sessionUpdatedAt: number;
  sourceKind: "node_question" | "node_response" | "node_reference" | "note";
  sourceId: string;
  snippet: string;
  matchText: string;
  coveredTerms: number;
  totalTerms: number;
};

const MIN_CHARS = 6;
const DEBOUNCE_MS = 600;

export function RelatedHints({ query }: { query: string }) {
  const jumpToSearchHit = useSessionStore((s) => s.jumpToSearchHit);
  const jumpToNoteSource = useSessionStore((s) => s.jumpToNoteSource);
  const [hits, setHits] = useState<RelatedHit[]>([]);
  const [dismissed, setDismissed] = useState(false);
  // 「本次草稿」的边界 = 输入被清空。用 prev-render 对比而不是 effect
  // 复位（react-hooks/set-state-in-effect 禁 effect 体内同步 setState）。
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    if (!query.trim() && dismissed) setDismissed(false);
  }

  const trimmed = query.trim();
  const eligible =
    trimmed.length >= MIN_CHARS &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("$");

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      fetch(`/api/search/related?q=${encodeURIComponent(trimmed)}`)
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) setHits((data.related as RelatedHit[]) ?? []);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [trimmed, eligible]);

  // 不清 hits 只做渲染门控：连续输入时提示条不闪烁，下一次 fetch 回来
  // 覆盖即可；输入缩短到不合格（含清空）直接藏。
  if (!eligible || dismissed || hits.length === 0) return null;

  const onJump = (h: RelatedHit) => {
    if (h.sourceKind === "note") {
      jumpToNoteSource(h.sourceId);
      return;
    }
    const matchKind: "question" | "response" | "reference" =
      h.sourceKind === "node_question"
        ? "question"
        : h.sourceKind === "node_response"
          ? "response"
          : "reference";
    void jumpToSearchHit({
      sessionId: h.sessionId,
      nodeId: h.sourceId,
      matchText: h.matchText,
      matchKind,
    });
  };

  return (
    <div className="mt-2 border border-line rounded-lg bg-surface/80 overflow-hidden">
      <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 text-label text-ink-faint">
        <span aria-hidden>🌿</span>
        <span>之前聊过相关的 —— 点行去原树续聊，不理会就是新开</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setDismissed(true)}
          title="本次输入不再提示"
          className="px-1 rounded hover:bg-surface-muted hover:text-ink-muted"
        >
          ✕
        </button>
      </div>
      {hits.map((h) => (
        <button
          key={h.sessionId}
          type="button"
          onClick={() => onJump(h)}
          className="w-full text-left px-3 py-2 border-t border-line-faint hover:bg-surface-muted transition-colors flex items-baseline gap-2"
        >
          <span className="text-ui text-ink font-medium shrink-0 max-w-[38%] truncate">
            {h.sessionTitle}
          </span>
          <span
            className="text-ui text-ink-muted flex-1 min-w-0 truncate"
            // FTS5 snippet 服务端已转义，<mark> 是唯一注入的 HTML（与
            // SearchModal 同一信任模型）。
            dangerouslySetInnerHTML={{ __html: h.snippet }}
          />
          <span className="text-label text-ink-faint shrink-0">
            {timeAgo(h.sessionUpdatedAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}
