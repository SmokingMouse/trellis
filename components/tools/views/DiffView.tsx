"use client";
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

  return (
    <>
      {filePath && (
        <div className="text-nano font-mono text-ink-faint truncate">
          {filePath}
        </div>
      )}
      {edit && <Hunk old={edit.old_string} next={edit.new_string} />}
      {write && <Hunk old="" next={write.content} />}
      {multi?.edits.map((e, i) => (
        <div key={i}>
          <div className="text-nano uppercase tracking-wider text-ink-faint mb-0.5">
            改动 {i + 1} / {multi.edits.length}
          </div>
          <Hunk old={e.old_string} next={e.new_string} />
        </div>
      ))}
      {call.status === "error" && call.output && (
        <Section label="输出">
          <OutputView text={call.output} />
        </Section>
      )}
    </>
  );
}

function Hunk({ old, next }: { old: string; next: string }) {
  const rows = collapseContext(lineDiff(old, next));
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;
  return (
    <div>
      <div className="mb-0.5 flex items-center gap-2 text-nano tabular-nums">
        <span className="text-positive-ink">+{added}</span>
        <span className="text-danger-ink">−{removed}</span>
      </div>
      <div className="border border-line rounded overflow-hidden bg-surface-canvas max-h-96 overflow-y-auto">
        {rows.map((r, i) =>
          r.kind === "gap" ? (
            <div
              key={i}
              className="px-2 py-0.5 text-nano text-ink-faint bg-surface-muted/60 border-y border-line/60"
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
  add: "bg-positive-muted text-positive-ink",
  del: "bg-danger-muted text-danger-ink",
  ctx: "text-ink-muted",
};

const SIGIL: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " " };

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={`flex items-start gap-2 px-2 font-mono text-label leading-snug ${ROW_STYLE[line.kind]}`}
    >
      <span className="shrink-0 w-10 text-right tabular-nums text-ink-faint select-none">
        {line.newNo ?? line.oldNo}
      </span>
      <span className="shrink-0 select-none">{SIGIL[line.kind]}</span>
      <span className="whitespace-pre-wrap break-words min-w-0">
        {line.text || " "}
      </span>
    </div>
  );
}
