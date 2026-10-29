"use client";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, Trash2 } from "lucide-react";
import { Button, Icon, IconButton, Textarea, cn } from "@/components/ui";
import type { DiffFile, DiffHunk, DiffLine } from "@/lib/unified-diff";
import { commentAnchor, diffLinePrefix, type ReviewComment } from "@/lib/diff-review";
import { highlightLine, languageFor } from "./highlight";

// 单文件 diff 层：统一视图、hunk 可折叠、点行写评论。
// 正文恒暗（--code-bg，与 Markdown 代码块一致），+/- 行用半透明绿 / 红底。
// 不折行时横向滚动只发生在这个容器内部，整个 sheet 不会被长行撑宽。

const LINE_BG: Record<DiffLine["kind"], string> = {
  add: "bg-(--code-add-bg)",
  del: "bg-(--code-del-bg)",
  ctx: "",
  meta: "",
};
const GUTTER_BG: Record<DiffLine["kind"], string> = {
  add: "bg-(--code-add-gutter)",
  del: "bg-(--code-del-gutter)",
  ctx: "bg-(--code-bg)",
  meta: "bg-(--code-bg)",
};
const PREFIX_INK: Record<DiffLine["kind"], string> = {
  add: "text-(--code-add-ink)",
  del: "text-(--code-del-ink)",
  ctx: "text-transparent",
  meta: "text-transparent",
};

// 超大文件先渲染这么多行，其余点按钮再出（手机上几万行 DOM 会卡死）
const INITIAL_LINE_BUDGET = 2000;

export type NewComment = { hunkIndex: number; lineIndex: number; body: string };

type Props = {
  file: DiffFile;
  wrap: boolean;
  collapsed: ReadonlySet<number>;
  onToggleHunk: (index: number) => void;
  comments: ReviewComment[];
  onAddComment: (c: NewComment) => void;
  onRemoveComment: (id: string) => void;
};

export function DiffFileView({ file, wrap, collapsed, onToggleHunk, comments, onAddComment, onRemoveComment }: Props) {
  const lang = useMemo(() => languageFor(file.path), [file.path]);
  const [editing, setEditing] = useState<{ hunk: number; line: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [budget, setBudget] = useState(INITIAL_LINE_BUDGET);
  // 评论卡片 / 编辑器在不折行（内容比容器宽）时也要贴住可视宽度：量一次容器宽
  const rootRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth - 2));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cardStyle = boxWidth ? { width: boxWidth } : undefined;

  const byAnchor = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const k = `${c.side}:${c.line}`;
      const arr = m.get(k);
      if (arr) arr.push(c);
      else m.set(k, [c]);
    }
    return m;
  }, [comments]);

  const openEditor = (hunk: number, line: number) => {
    // 桌面上拖选文字复制时不弹编辑器
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
    setEditing({ hunk, line });
    setDraft("");
  };
  const submit = () => {
    if (!editing || !draft.trim()) return;
    onAddComment({ hunkIndex: editing.hunk, lineIndex: editing.line, body: draft.trim() });
    setEditing(null);
    setDraft("");
  };
  const onEditorKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
    }
  };

  if (file.binary) {
    return <p className="px-4 py-6 text-label text-ink-faint">二进制文件，无法显示文本差异。</p>;
  }
  if (file.hunks.length === 0) {
    return (
      <p className="px-4 py-6 text-label text-ink-faint">
        {file.status === "R" ? `仅重命名：${file.oldPath} → ${file.path}` : "没有文本内容变化（可能只改了文件权限）。"}
      </p>
    );
  }

  // 按行预算分配每个 hunk 可见行数（折叠的 hunk 不占预算）
  const visibleCounts: number[] = [];
  let remaining = budget;
  let hiddenLines = 0;
  file.hunks.forEach((hunk, hi) => {
    const v = collapsed.has(hi) ? 0 : Math.max(0, Math.min(hunk.lines.length, remaining));
    if (!collapsed.has(hi)) {
      hiddenLines += hunk.lines.length - v;
      remaining -= v;
    }
    visibleCounts.push(v);
  });

  return (
    <div ref={rootRef} className="flex flex-col gap-2 pb-4">
      {file.hunks.map((hunk, hi) => {
        const isCollapsed = collapsed.has(hi);
        const visible = visibleCounts[hi];
        return (
          <section key={hi} className="overflow-hidden rounded-card border border-line">
            <button
              type="button"
              onClick={() => onToggleHunk(hi)}
              aria-expanded={!isCollapsed}
              className="flex w-full min-w-0 items-center gap-1.5 bg-surface-muted px-2 py-1 text-left font-mono text-nano text-accent-ink hover:bg-surface-hover max-md:min-h-11"
            >
              <Icon icon={isCollapsed ? ChevronRight : ChevronDown} size="sm" className="shrink-0 text-ink-faint" />
              <span className="shrink-0">{hunkRange(hunk)}</span>
              {hunk.section && <span className="min-w-0 truncate text-ink-faint">{hunk.section}</span>}
            </button>
            {visible > 0 && (
              <div className={cn("bg-(--code-bg) text-(--code-ink)", !wrap && "overflow-x-auto overscroll-x-contain")} data-diff-scroll={wrap ? undefined : "x"}>
                <div className={cn("font-mono text-nano leading-relaxed", wrap ? "w-full" : "inline-block min-w-full")}>
                  {hunk.lines.slice(0, visible).map((line, li) => {
                    const anchor = commentAnchor(line);
                    const lineComments = anchor ? byAnchor.get(`${anchor.side}:${anchor.line}`) : undefined;
                    const isEditing = editing?.hunk === hi && editing.line === li;
                    return (
                      <div key={li}>
                        <DiffRow
                          line={line}
                          lang={lang}
                          wrap={wrap}
                          active={isEditing}
                          onComment={anchor ? () => openEditor(hi, li) : undefined}
                        />
                        {lineComments?.map((c) => (
                          <div key={c.id} style={cardStyle} className="sticky left-0 max-w-full border-y border-line bg-surface px-3 py-2 font-sans text-ui text-ink">
                            <div className="flex items-start gap-2">
                              <p className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{c.body}</p>
                              <IconButton label="删除这条评论" size="sm" tone="danger" onClick={() => onRemoveComment(c.id)}>
                                <Icon icon={Trash2} size="sm" />
                              </IconButton>
                            </div>
                          </div>
                        ))}
                        {isEditing && (
                          <div style={cardStyle} className="sticky left-0 border-y border-line bg-surface px-3 py-2 font-sans">
                            <Textarea
                              autoFocus
                              rows={3}
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={onEditorKey}
                              placeholder={`评论 ${file.path}:${anchor?.line ?? ""}（⌘↵ 添加）`}
                              aria-label="评论内容"
                              className="text-ui"
                            />
                            <div className="mt-2 flex justify-end gap-2">
                              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                                取消
                              </Button>
                              <Button variant="primary" size="sm" onClick={submit} disabled={!draft.trim()}>
                                添加评论
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })}
      {hiddenLines > 0 && (
        <Button variant="secondary" onClick={() => setBudget((b) => b + INITIAL_LINE_BUDGET * 2)} className="self-center">
          还有 {hiddenLines} 行未显示，继续加载
        </Button>
      )}
    </div>
  );
}

function hunkRange(h: DiffHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

const DiffRow = memo(function DiffRow({
  line,
  lang,
  wrap,
  active,
  onComment,
}: {
  line: DiffLine;
  lang: string | null;
  wrap: boolean;
  active: boolean;
  onComment?: () => void;
}) {
  const no = line.kind === "del" ? line.oldNo : line.newNo;
  return (
    <div
      className={cn("group flex", LINE_BG[line.kind], active && "outline outline-1 -outline-offset-1 outline-accent", onComment && "cursor-pointer")}
      onClick={onComment}
    >
      {/* 行号栏：可聚焦按钮（键盘 / 读屏可达的评论入口），不折行时贴左吸附 */}
      <span className={cn("sticky left-0 z-1 flex shrink-0 select-none", GUTTER_BG[line.kind])}>
        <span className="hidden w-10 pr-1 text-right tabular-nums text-(--code-muted) md:inline-block">{line.oldNo ?? ""}</span>
        {onComment ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onComment();
            }}
            aria-label={`评论第 ${no} 行`}
            className="relative w-10 pr-1 text-right tabular-nums text-(--code-muted) hover:text-(--code-ink) focus-visible:outline focus-visible:outline-accent"
          >
            <span className="group-hover:invisible">{line.newNo ?? <span className="md:hidden">{line.oldNo}</span>}</span>
            <Icon icon={MessageSquarePlus} size="sm" className="invisible absolute right-1 top-1/2 -translate-y-1/2 text-accent group-hover:visible" />
          </button>
        ) : (
          <span className="w-10 pr-1" />
        )}
      </span>
      <span className={cn("w-4 shrink-0 select-none text-center", PREFIX_INK[line.kind])}>{diffLinePrefix(line.kind) || " "}</span>
      <code
        className={cn(
          "min-w-0 flex-1 pr-3",
          wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre",
          line.kind === "meta" && "italic text-(--code-muted)",
        )}
      >
        {line.kind === "meta" ? line.text : highlightLine(line.text, lang) || " "}
      </code>
    </div>
  );
});
