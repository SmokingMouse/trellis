"use client";
import { useState } from "react";
import { ChevronRight, FileDiff, X } from "lucide-react";
import { Drawer, Icon, IconButton } from "@/components/ui";
import { useIsMobile } from "@/hooks/useIsMobile";
import { collapseContext, lineDiff, type DiffLine } from "@/lib/line-diff";
import type { ToolNode } from "@/lib/tool-tree";
import { OutputView, Section } from "../RawView";

// Edit / MultiEdit / Write bodies. The single biggest readability win in the
// timeline: an Edit used to render as a JSON blob with old_string and
// new_string as two escaped one-liners, which is unreadable at any length.

type EditInput = { file_path?: string; old_string: string; new_string: string };
type WriteInput = { file_path?: string; content: string };
type MultiEditInput = {
  file_path?: string;
  edits: Array<{ old_string: string; new_string: string }>;
};

function asEdit(input: unknown): EditInput | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  return typeof o.old_string === "string" && typeof o.new_string === "string"
    ? (o as EditInput)
    : null;
}

function asWrite(input: unknown): WriteInput | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  return typeof o.content === "string" ? (o as WriteInput) : null;
}

function asMultiEdit(input: unknown): MultiEditInput | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (!Array.isArray(o.edits)) return null;
  const ok = o.edits.every(
    (e) =>
      e &&
      typeof e === "object" &&
      typeof (e as Record<string, unknown>).old_string === "string" &&
      typeof (e as Record<string, unknown>).new_string === "string",
  );
  return ok ? (o as unknown as MultiEditInput) : null;
}

export function canRenderDiff(node: ToolNode): boolean {
  const i = node.call.input;
  return Boolean(asEdit(i) ?? asWrite(i) ?? asMultiEdit(i));
}

export function DiffView({ node }: { node: ToolNode }) {
  const { call } = node;
  const edit = asEdit(call.input);
  const write = edit ? null : asWrite(call.input);
  const multi = edit || write ? null : asMultiEdit(call.input);
  const filePath =
    (call.input as { file_path?: string } | null)?.file_path ?? null;
  // 手机（2026-10-30，参考 Cindy DiffPreview）：时间线里只留一行「文件名 +x −y」
  // 摘要，点开用底部 sheet 看完整 diff——不再在窄屏里嵌一个 max-h-96 的内滚动框。
  // null（首帧未知）按桌面渲染，和 useIsMobile 的约定一致。
  const isMobile = useIsMobile() === true;
  const [sheetOpen, setSheetOpen] = useState(false);
  // Drawer 外壳常驻挂载（全屏 fixed 层）：一轮里几十个 Edit 不必各挂一个，
  // 第一次点开才挂，之后留着给退场动画用。
  const [sheetMounted, setSheetMounted] = useState(false);
  const pairs: Array<{ old: string; next: string }> = edit
    ? [{ old: edit.old_string, next: edit.new_string }]
    : write
      ? [{ old: "", next: write.content }]
      : (multi?.edits.map((e) => ({ old: e.old_string, next: e.new_string })) ?? []);
  const hunks = pairs.map((p) => collapseContext(lineDiff(p.old, p.next)));

  const body = (
    <>
      {hunks.map((rows, i) => (
        <div key={i}>
          {hunks.length > 1 && (
            <div className="text-nano uppercase tracking-wider text-ink-faint mb-0.5">
              改动 {i + 1} / {hunks.length}
            </div>
          )}
          <Hunk rows={rows} />
        </div>
      ))}
      {call.status === "error" && call.output && (
        <Section label="输出">
          <OutputView text={call.output} />
        </Section>
      )}
    </>
  );

  if (isMobile) {
    const { added, removed } = countRows(hunks.flat());
    const name = filePath ? basename(filePath) : "改动";
    return (
      <>
        <button
          type="button"
          data-diff-summary=""
          onClick={() => {
            setSheetMounted(true);
            setSheetOpen(true);
          }}
          aria-haspopup="dialog"
          aria-label={`查看 ${name} 的完整改动`}
          className="press-row flex w-full min-h-11 items-center gap-2 rounded-field bg-surface px-3 text-left text-ui"
        >
          <Icon icon={FileDiff} size="sm" className="text-ink-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-label text-ink">{name}</span>
          <span className="shrink-0 font-mono text-label tabular-nums text-positive-ink">+{added}</span>
          <span className="shrink-0 font-mono text-label tabular-nums text-danger-ink">−{removed}</span>
          <Icon icon={ChevronRight} size="sm" className="text-ink-faint" />
        </button>
        {call.status === "error" && call.output && (
          <Section label="输出">
            <OutputView text={call.output} />
          </Section>
        )}
        {sheetMounted && (
          <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} title={`改动：${filePath ?? name}`}>
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-ui font-medium text-ink-strong">{name}</div>
                {filePath && filePath !== name && (
                  <div className="truncate font-mono text-nano text-ink-faint">{filePath}</div>
                )}
              </div>
              <span className="shrink-0 font-mono text-label tabular-nums text-positive-ink">+{added}</span>
              <span className="shrink-0 font-mono text-label tabular-nums text-danger-ink">−{removed}</span>
              <IconButton label="关闭" onClick={() => setSheetOpen(false)}>
                <Icon icon={X} />
              </IconButton>
            </div>
            <div data-diff-sheet="" className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3">
              {body}
            </div>
          </Drawer>
        )}
      </>
    );
  }

  return (
    <>
      {filePath && (
        <div className="text-nano font-mono text-ink-faint truncate">
          {filePath}
        </div>
      )}
      {body}
    </>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function countRows(rows: DiffRowLike[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}

type DiffRowLike = ReturnType<typeof collapseContext>[number];

// 配色与 diff 审阅（components/diff-review/DiffFileView.tsx）统一走 --code-* 恒暗代码面：
// 同一份改动在时间线和审阅页里长一个样。
function Hunk({ rows }: { rows: DiffRowLike[] }) {
  const { added, removed } = countRows(rows);
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-2 text-nano tabular-nums">
        <span className="text-positive-ink">+{added}</span>
        <span className="text-danger-ink">−{removed}</span>
      </div>
      {/* 桌面保留 max-h-96 内滚动；手机在 sheet 里整页滚，不再嵌套滚动 */}
      <div className="rounded overflow-hidden border border-(--code-bar-line) bg-(--code-bg) text-(--code-ink) md:max-h-96 md:overflow-y-auto">
        {rows.map((r, i) =>
          r.kind === "gap" ? (
            <div
              key={i}
              className="px-2 py-0.5 text-nano text-(--code-muted) bg-(--code-bar-bg)"
            >
              ⋯ {r.hidden} 行未变
            </div>
          ) : (
            <DiffRow key={i} line={r} />
          ),
        )}
      </div>
    </div>
  );
}

const ROW_STYLE: Record<DiffLine["kind"], string> = {
  add: "bg-(--code-add-bg)",
  del: "bg-(--code-del-bg)",
  ctx: "",
};

const SIGIL_INK: Record<DiffLine["kind"], string> = {
  add: "text-(--code-add-ink)",
  del: "text-(--code-del-ink)",
  ctx: "text-(--code-muted)",
};

const SIGIL: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " " };

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={`flex items-start gap-2 px-2 font-mono text-label leading-snug max-md:gap-1.5 max-md:px-1.5 ${ROW_STYLE[line.kind]}`}
    >
      {/* 行号列：手机上收窄（sheet 里宽度金贵） */}
      <span className="shrink-0 w-10 text-right tabular-nums text-(--code-muted) select-none max-md:w-7 max-md:text-nano">
        {line.newNo ?? line.oldNo}
      </span>
      <span className={`shrink-0 select-none ${SIGIL_INK[line.kind]}`}>{SIGIL[line.kind]}</span>
      <span className="whitespace-pre-wrap break-words min-w-0">
        {line.text || " "}
      </span>
    </div>
  );
}
