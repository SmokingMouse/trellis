import { getSession } from "./repo";
import { getDB } from "./sqlite";
import { resolveDaemonPaths } from "@smokingmouse/agent-server/paths";
import { isShadowEnabled, isAdoptEnabled } from "../as-config";

export type SessionBinding =
  | { type: "legacy" }
  | { type: "pane"; sessionId: string }
  | { type: "fallback"; sessionId: string; reason: "disabled" }
  | { type: "thread"; sessionId: string; daemonId: string };

/** pane is reserved for feat/herdr-bridge's herdr_sessions adapter. Never spawn for it. */
export function parseSessionBinding(session: { id: string; bindingType?: string }, daemonId: string, enabled = true): SessionBinding {
  switch (session.bindingType ?? "legacy") {
    case "legacy": return { type: "legacy" };
    case "pane": return { type: "pane", sessionId: session.id };
    case "thread": return enabled ? { type: "thread", sessionId: session.id, daemonId } : { type: "fallback", sessionId: session.id, reason: "disabled" };
    default: throw new Error(`unknown session binding: ${session.bindingType}`);
  }
}
export function daemonIdentity() { return process.env.TRELLIS_AS_SOCKET ?? resolveDaemonPaths().socketPath; }
export function resolveSessionBinding(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) throw new Error("session not found");
  return parseSessionBinding(session, daemonIdentity(), isShadowEnabled());
}
export function newProjectBinding(mode: string, agentId?: string | null): "legacy" | "thread" {
  return mode === "project" && !agentId && isShadowEnabled() && process.env.TRELLIS_AS_PROJECT === "on" ? "thread" : "legacy";
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
/** Reserve before the RPC: retry forks are not committed to as_turns until success. */
export function claimAsThread(sessionId: string, clientThreadId: string) {
  if (!isAdoptEnabled()) return;
  getDB().prepare("INSERT INTO as_thread_claims (daemon_id,client_thread_id,session_id) VALUES (?,?,?)")
    .run(daemonIdentity(),clientThreadId,sessionId);
}
export function hasAsThreadClaim(clientThreadId?: string) {
  return !!clientThreadId && !!getDB().prepare("SELECT 1 FROM as_thread_claims WHERE daemon_id=? AND client_thread_id=?")
    .get(daemonIdentity(),clientThreadId);
}
export function bindAsTurn(nodeId: string, threadId: string, clientTurnId: string) {
  getDB().prepare(`INSERT INTO as_turns (node_id,thread_id,daemon_id,client_turn_id,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET thread_id=excluded.thread_id,daemon_id=excluded.daemon_id,
    client_turn_id=excluded.client_turn_id,turn_id=NULL,last_item_id=NULL,request_json=NULL,resolved_json=NULL,created_at=excluded.created_at`)
    .run(nodeId, threadId, daemonIdentity(), clientTurnId, Date.now());
}
export function pruneAsThreads(sessionId: string) {
  getDB().prepare(`DELETE FROM as_threads WHERE session_id=? AND NOT EXISTS (
    SELECT 1 FROM as_turns t WHERE t.thread_id=as_threads.thread_id AND t.daemon_id=as_threads.daemon_id
  ) AND NOT EXISTS (
    SELECT 1 FROM as_adoptions a WHERE a.thread_id=as_threads.thread_id AND a.daemon_id=as_threads.daemon_id AND a.session_id IS NOT NULL
  )`).run(sessionId);
}
export function removeAsTurn(nodeId: string) {
  const sessionId = getDB().prepare("SELECT session_id FROM nodes WHERE id=?").get(nodeId) as {session_id:string} | null;
  getDB().transaction(() => {
    getDB().prepare("DELETE FROM as_turns WHERE node_id=?").run(nodeId);
    if (sessionId) pruneAsThreads(sessionId.session_id);
  })();
}
export function updateAsTurn(nodeId: string, turnId: string, lastItemId?: string) {
  getDB().prepare("UPDATE as_turns SET turn_id=?,last_item_id=COALESCE(?,last_item_id) WHERE node_id=?")
    .run(turnId, lastItemId ?? null, nodeId);
}
