import type { ChatNode } from "@/lib/types";

type ContextNode = Pick<
  ChatNode,
  "id" | "parentId" | "tokenCount" | "createdAt"
>;

// A turn's true context-window occupancy. Prefer the backend-reported
// contextTokens; fall back to the input+cache sum for legacy rows / backends
// that don't report it.
export function ctxTokensOf(node: ContextNode): number {
  const contextTokens = node.tokenCount.contextTokens;
  if (typeof contextTokens === "number" && contextTokens > 0) {
    return contextTokens;
  }
  return (
    node.tokenCount.input +
    node.tokenCount.cacheRead +
    node.tokenCount.cacheCreation
  );
}

// Context belongs to the active node's lineage, not to whichever sibling
// branch happened to produce the newest turn. Walk toward the root and use
// the nearest turn that reported a usable context value.
export function findLineageCtxTurn(
  activeNodeId: string,
  nodes: Record<string, ContextNode>,
): ContextNode | null {
  let current: ContextNode | undefined = nodes[activeNodeId];
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (ctxTokensOf(current) > 0) return current;
    current = current.parentId ? nodes[current.parentId] : undefined;
  }
  return null;
}

/**
 * Detects whether conversation context was automatically compacted before/at this turn.
 * Sourced either from CLI-injected continuation summary markers in question text,
 * or a noticeable context occupancy drop (e.g. >=40k tokens dropped by >=40%).
 */
export function isContextCompacted(
  currNode: { question?: string; tokenCount: ChatNode["tokenCount"] },
  prevNode?: { question?: string; tokenCount: ChatNode["tokenCount"] },
): boolean {
  if (!currNode) return false;

  const q = currNode.question ?? "";
  if (
    q.includes("This session is being continued from a previous conversation that ran out of context") ||
    q.includes("The summary below covers the earlier portion of the conversation")
  ) {
    return true;
  }

  if (prevNode) {
    const prevCtx = ctxTokensOf(prevNode as any);
    const currCtx = ctxTokensOf(currNode as any);
    if (
      prevCtx >= 40_000 &&
      currCtx > 0 &&
      currCtx <= prevCtx * 0.6 &&
      prevCtx - currCtx >= 30_000
    ) {
      return true;
    }
  }

  return false;
}
