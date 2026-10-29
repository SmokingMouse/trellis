"use client";
import { useEffect, useMemo, useState } from "react";
import { Button, ErrorCallout, SkeletonText, cn } from "@/components/ui";
import type { DiffFile } from "@/lib/unified-diff";
import { highlightLine, languageFor } from "./highlight";

// 完整文件层：读 /api/workspaces/git-diff/file（工作区当前内容；已删除文件读 HEAD），
// 带行号与语法高亮，本次新增的行在行号栏标绿。

type FileRes = { content: string; binary: boolean; truncated: boolean; rev: "worktree" | "head"; size: number };

const INITIAL_LINES = 3000;

export function FullFileView({ query, file, wrap }: { query: string; file: DiffFile; wrap: boolean }) {
  const [res, setRes] = useState<FileRes | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [limit, setLimit] = useState(INITIAL_LINES);
  const lang = useMemo(() => languageFor(file.path), [file.path]);
  const added = useMemo(() => {
    const s = new Set<number>();
    for (const h of file.hunks) for (const l of h.lines) if (l.kind === "add" && l.newNo !== null) s.add(l.newNo);
    return s;
  }, [file]);

  useEffect(() => {
    const ctrl = new AbortController();
    const rev = file.status === "D" ? "&rev=head" : "";
    fetch(`/api/workspaces/git-diff/file?${query}&path=${encodeURIComponent(file.path)}${rev}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else {
          setError(null);
          setRes(j);
        }
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e);
      });
    return () => ctrl.abort();
  }, [query, file.path, file.status, reload]);

  const lines = useMemo(() => (res ? res.content.replace(/\n$/, "").split("\n") : []), [res]);

  if (error) {
    return <ErrorCallout error={error} title="读取文件失败" onRetry={() => { setError(null); setRes(null); setReload((k) => k + 1); }} />;
  }
  if (!res) {
    return (
      <div role="status" aria-label="正在读取文件" className="p-1">
        <SkeletonText lines={8} />
      </div>
    );
  }
  if (res.binary) return <p className="px-4 py-6 text-label text-ink-faint">二进制文件，无法预览。</p>;

  return (
    <div className="flex flex-col gap-2 pb-4">
      {(res.rev === "head" || res.truncated) && (
        <p className="text-label text-ink-faint">
          {res.rev === "head" && "文件已在工作区删除，显示的是 HEAD 版本。"}
          {res.truncated && `文件较大，只显示前 1MB（共 ${Math.round(res.size / 1024)}KB）。`}
        </p>
      )}
      <div className={cn("rounded-card border border-line bg-(--code-bg) text-(--code-ink)", !wrap && "overflow-x-auto overscroll-x-contain")} data-diff-scroll={wrap ? undefined : "x"}>
        <div className={cn("font-mono text-nano leading-relaxed", wrap ? "w-full" : "inline-block min-w-full")}>
          {lines.slice(0, limit).map((text, i) => {
            const no = i + 1;
            const isAdded = res.rev === "worktree" && added.has(no);
            return (
              <div key={i} className={cn("flex", isAdded && "bg-(--code-add-bg)")}>
                <span
                  className={cn(
                    "sticky left-0 w-12 shrink-0 select-none border-r pr-2 text-right tabular-nums text-(--code-muted)",
                    isAdded ? "border-(--code-add-ink) bg-(--code-add-gutter)" : "border-transparent bg-(--code-bg)",
                  )}
                >
                  {no}
                </span>
                <code className={cn("min-w-0 flex-1 px-3", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre")}>
                  {highlightLine(text, lang) || " "}
                </code>
              </div>
            );
          })}
        </div>
      </div>
      {lines.length > limit && (
        <Button variant="secondary" onClick={() => setLimit((n) => n + INITIAL_LINES)} className="self-center">
          还有 {lines.length - limit} 行，继续加载
        </Button>
      )}
    </div>
  );
}
