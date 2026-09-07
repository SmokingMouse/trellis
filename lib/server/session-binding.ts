import { getSession } from "./repo";
import { getDB } from "./sqlite";
import { resolveDaemonPaths } from "@smokingmouse/agent-server/paths";

export type SessionBinding =
  | { type: "legacy" }
  | { type: "pane"; sessionId: string }
  | { type: "thread"; sessionId: string; daemonId: string };

/** pane is reserved for feat/herdr-bridge's herdr_sessions adapter. Never spawn for it. */
export function parseSessionBinding(session: { id: string; bindingType?: string }, daemonId: string): SessionBinding {
  switch (session.bindingType ?? "legacy") {
    case "legacy": return { type: "legacy" };
    case "pane": return { type: "pane", sessionId: session.id };
    case "thread": return { type: "thread", sessionId: session.id, daemonId };
    default: throw new Error(`unknown session binding: ${session.bindingType}`);
  }
}
export function daemonIdentity() { return process.env.TRELLIS_AS_SOCKET ?? resolveDaemonPaths().socketPath; }
export function resolveSessionBinding(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");
  return parseSessionBinding(session, daemonIdentity());
}
export function newProjectBinding(mode: string, agentId?: string | null): "legacy" | "thread" {
  return mode === "project" && !agentId && process.env.TRELLIS_AS === "on" && process.env.TRELLIS_AS_PROJECT === "on" ? "thread" : "legacy";
}
export type AsTurn = {
  node_id: string; thread_id: string; daemon_id: string; turn_id: string | null;
  client_turn_id: string; last_item_id: string | null; created_at: number;
};
export function getAsTurn(nodeId: string): AsTurn | null {
  return getDB().prepare("SELECT * FROM as_turns WHERE node_id=?").get(nodeId) as AsTurn | null;
}
export function bindAsThread(sessionId: string, threadId: string) {
  getDB().prepare("INSERT OR IGNORE INTO as_threads (session_id,thread_id,daemon_id,created_at) VALUES (?,?,?,?)")
    .run(sessionId, threadId, daemonIdentity(), Date.now());
}
export function bindAsTurn(nodeId: string, threadId: string, clientTurnId: string) {
  getDB().prepare(`INSERT INTO as_turns (node_id,thread_id,daemon_id,client_turn_id,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET thread_id=excluded.thread_id,daemon_id=excluded.daemon_id,
    client_turn_id=excluded.client_turn_id,turn_id=NULL,last_item_id=NULL,created_at=excluded.created_at`)
    .run(nodeId, threadId, daemonIdentity(), clientTurnId, Date.now());
}
export function updateAsTurn(nodeId: string, turnId: string, lastItemId?: string) {
  getDB().prepare("UPDATE as_turns SET turn_id=?,last_item_id=COALESCE(?,last_item_id) WHERE node_id=?")
    .run(turnId, lastItemId ?? null, nodeId);
}
