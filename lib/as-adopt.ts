import path from "node:path";
import type { AttachResult, Item, Thread, Turn } from "@smokingmouse/agent-server/protocol";

export type AdoptionRoot = { id: string; projectId: string; path: string };
/** Longest containing root wins; a sibling with the same prefix is not a child. */
export function matchAdoptionRoot(cwd: string, roots: AdoptionRoot[]) {
  const target = path.resolve(cwd);
  return roots.filter(root => {
    const relative = path.relative(path.resolve(root.path), target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

export function adoptionTitle(thread: Thread) {
  const fj = thread.meta?.fjContext as { cid?: string } | undefined;
  const title = thread.title || (typeof thread.meta?.title === "string" ? thread.meta.title : undefined);
  return [fj?.cid, title].filter(Boolean).join(" · ") || `${thread.backend} 外部会话`;
}

/** as/1 attach has items, not historic Turn records. Live turn events are authoritative;
 * old status is derived from the item lifecycle, without inventing usage. */
export function adoptionTurns(snapshot: AttachResult, turns: Record<string, Turn> = {}) {
  const groups = new Map<string, Item[]>();
  for (const item of [...snapshot.items].sort((a,b) => a.seq-b.seq)) {
    const group = groups.get(item.turnId) ?? [];
    group.push(item); groups.set(item.turnId, group);
  }
  return [...groups].map(([id, items], index, all) => {
    const user = items.find(i => i.type === "userMessage");
    const content = user?.type === "userMessage" ? user.payload.content : [];
    const running = index === all.length - 1 && snapshot.thread.status.type === "running";
    const failed = items.some(i => i.type === "error") || items.at(-1)?.status === "failed"
      || index === all.length - 1 && ["interrupted", "systemError"].includes(snapshot.thread.status.type);
    const turn: Turn = turns[id] ?? { id, threadId: snapshot.thread.id, ordinal: index+1,
      clientTurnId: user?.type === "userMessage" ? user.payload.clientTurnId : undefined,
      enqueuedAtMs: items[0].startedAtMs, status: running ? "inProgress" : failed ? "failed" : "completed" };
    return { turn, items, content, question: content.map(i => i.type === "text" ? i.text : i.type === "bash" ? i.command : `[${i.type}] ${i.path}`).join("\n") || "外部操作" };
  });
}
