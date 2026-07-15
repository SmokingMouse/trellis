// Pub/sub for streaming token deltas, intentionally outside React state.
//
// During streaming we route delta events through this bus instead of the
// Zustand store. Subscribers (the streaming node's <pre> ref) write
// directly to DOM `textContent`, so React doesn't re-render and ReactFlow
// doesn't run its internal node/edge diff per token. The full text is
// also buffered here so a late-mounting subscriber (HMR, fullscreen
// toggle) can hydrate from the latest accumulated text.
//
// On "done" / "error", sessionStore commits the full buffered text into
// React state in a single set() — that triggers exactly one normal render
// where the node flips back to the full ReactMarkdown + rehype-highlight
// pipeline.

type Listener = (delta: string) => void;

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, string>();

// Extended thinking rides the same bus on a namespaced channel key (thinking
// deltas stream BEFORE any text delta; UI shows them live, drops them on
// done). " " can't appear in a node id, so no collision with real ids.
export function thinkingChannel(nodeId: string): string {
  return nodeId + " thinking";
}

export function subscribeStream(nodeId: string, cb: Listener): () => void {
  let set = listeners.get(nodeId);
  if (!set) {
    set = new Set();
    listeners.set(nodeId, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(nodeId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(nodeId);
  };
}

export function emitStream(nodeId: string, delta: string): void {
  const cur = pending.get(nodeId) ?? "";
  pending.set(nodeId, cur + delta);
  const set = listeners.get(nodeId);
  if (!set) return;
  for (const cb of set) cb(delta);
}

// Returns text accumulated since the last clear — used by a freshly
// mounted subscriber to catch up before subscribing.
export function getStreamPending(nodeId: string): string {
  return pending.get(nodeId) ?? "";
}

export function clearStreamPending(nodeId: string): void {
  pending.delete(nodeId);
}
