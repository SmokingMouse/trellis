import { Fragment, type ReactNode } from "react";

// 搜索片段渲染。片段来自 FTS5 snippet()（或 1–2 字查询的 LIKE 回退）：只在命中处
// 插 <mark>，**不转义原文**——索引里存的是原始提问 / 回复文本，回复里的 HTML 会
// 原样出现。所以这里不走 dangerouslySetInnerHTML，只认 <mark> / </mark> 两个
// 标记，其余一律当文本交给 React 转义。
export function SearchSnippet({ html }: { html: string }) {
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
