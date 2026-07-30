"use client";
import type { ToolNode } from "@/lib/tool-tree";

// TodoWrite. The result is always the same boilerplate acknowledgement, so the
// input *is* the content — which the JSON fallback rendered as an escaped blob
// exactly when the user most wants to skim "what's left".

type Todo = { content: string; status: string; activeForm?: string };

function asTodos(input: unknown): Todo[] | null {
  if (!input || typeof input !== "object") return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const ok = todos.every(
    (t) =>
      t &&
      typeof t === "object" &&
      typeof (t as Record<string, unknown>).content === "string" &&
      typeof (t as Record<string, unknown>).status === "string",
  );
  return ok ? (todos as Todo[]) : null;
}

export function canRenderTodo(node: ToolNode): boolean {
  return asTodos(node.call.input) !== null;
}

const MARK: Record<string, string> = {
  completed: "✔",
  in_progress: "▸",
  pending: "○",
};

const TONE: Record<string, string> = {
  completed: "text-ink-faint line-through",
  in_progress: "text-warn-ink font-medium",
  pending: "text-ink-muted",
};

export function TodoView({ node }: { node: ToolNode }) {
  const todos = asTodos(node.call.input) ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div>
      <div className="text-nano uppercase tracking-wider text-ink-faint mb-1">
        {done} / {todos.length} 完成
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-label">
            <span className="shrink-0 w-3 text-center select-none text-ink-faint">
              {MARK[t.status] ?? "·"}
            </span>
            <span className={TONE[t.status] ?? "text-ink-muted"}>
              {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
