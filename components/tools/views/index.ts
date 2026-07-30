import type { ComponentType, ReactNode } from "react";
import type { ToolNode } from "@/lib/tool-tree";
import { canRenderDiff, DiffView } from "./DiffView";
import { SubagentView } from "./SubagentView";
import { canRenderTodo, TodoView } from "./TodoView";
import { canRenderWorkflow, WorkflowView } from "./WorkflowView";

// The component registry — deliberately tiny.
//
// Most tools need nothing here; one line in lib/tool-registry.ts covers them.
// A tool earns an entry only when its *body* is genuinely a different thing
// (a diff, a checklist, a phase tree), not merely differently-shaped JSON.
//
// `canRender` is the escape hatch every such registry needs: payloads drift
// (a new CLI renames a field, an older row predates it), and a view that
// silently renders a blank card is worse than the raw JSON it replaced. When
// canRender says no, ToolRow falls back to RawView.

export type ToolViewProps = { node: ToolNode; children?: ReactNode };

export type ToolView = {
  Component: ComponentType<ToolViewProps>;
  canRender: (node: ToolNode) => boolean;
};

const BY_NAME: Record<string, ToolView> = {
  Edit: { Component: DiffView, canRender: canRenderDiff },
  MultiEdit: { Component: DiffView, canRender: canRenderDiff },
  Write: { Component: DiffView, canRender: canRenderDiff },
  TodoWrite: { Component: TodoView, canRender: canRenderTodo },
};

/**
 * Kind wins over name: a delegation is a delegation whether the CLI called the
 * tool `Agent`, `Task`, or something it hasn't shipped yet, and a sub-agent
 * view can render off task metadata alone.
 */
export function resolveToolView(node: ToolNode): ToolView | null {
  if (node.kind === "subagent") {
    return { Component: SubagentView, canRender: () => true };
  }
  if (node.kind === "workflow") {
    return { Component: WorkflowView, canRender: canRenderWorkflow };
  }
  return BY_NAME[node.call.name] ?? null;
}
