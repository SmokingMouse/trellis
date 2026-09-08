import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import { NotificationSchemas, type NotificationMethod, type AttachResult, type Thread, type Turn } from "@smokingmouse/agent-server/protocol";
import { isAdoptEnabled } from "../as-config";
import { adoptionTitle, adoptionTurns, matchAdoptionRoot, type AdoptionRoot } from "../as-adopt";
import { itemToolCall, projectResponse, projectInteraction } from "../as-project-events";
import { createProjectClient } from "./as-client";
import { hasActiveProjectRun } from "./as-project";
import { getDB } from "./sqlite";
import { bindAsThread, bindAsTurn, daemonIdentity, updateAsTurn, hasAsThreadClaim } from "./session-binding";
import { createBranchNode, createRootInSession, getNode, finalizeNode, persistPendingInteraction, clearPendingInteraction } from "./repo";

function canonicalWorkspacePath(value: string): string {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); }
  catch { const parent = path.dirname(absolute); return parent === absolute ? absolute : path.join(canonicalWorkspacePath(parent),path.basename(absolute)); }
}

export const EXTERNAL_PROJECT_KEY = "trellis:external";
type Adoption = { session_id: string | null; status: string; metadata_json: string };
export function getAdoption(sessionId: string) {
  return getDB().prepare("SELECT * FROM as_adoptions WHERE session_id=? AND daemon_id=?")
    .get(sessionId, daemonIdentity()) as (Adoption & {thread_id:string; backend:string}) | null;
}

export function resolveAdoptionWorkspace(cwd: string, bridges: { repo_root: string; checkout_path: string; git_branch?: string | null }[] = []) {
  const db = getDB(), now = Date.now();
  const roots = db.prepare(`SELECT w.id,w.project_id AS projectId,w.path FROM workspaces w
    JOIN projects p ON p.id=w.project_id WHERE p.cluster_key NOT IN ('trellis:external','trellis:scratch','trellis:home')`)
    .all() as AdoptionRoot[];
  for (const root of roots) root.path = canonicalWorkspacePath(root.path);
  // Herdr worktrees can live outside their repository directory.
  for (const bridge of bridges) {
    const rootPath = canonicalWorkspacePath(bridge.repo_root);
    const repo = matchAdoptionRoot(rootPath, roots)
      ?? matchAdoptionRoot(canonicalWorkspacePath(bridge.checkout_path), roots);
    if (!repo) continue;
    const checkout = canonicalWorkspacePath(bridge.checkout_path);
    for (const location of new Set([rootPath,checkout])) {
      if (roots.some(r => r.path === location)) continue;
      const kind = location === rootPath ? "directory" : "worktree";
      db.prepare(`INSERT OR IGNORE INTO workspaces (id,project_id,name,path,kind,git_branch,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), repo.projectId, path.basename(location), location, kind, bridge.git_branch ?? null, "discovered", now);
      // A first scan can precede the Herdr handshake. Promote its system
      // fallback when the authoritative repo/worktree relation arrives.
      db.prepare(`UPDATE workspaces SET project_id=?,kind=?,git_branch=? WHERE path=? AND project_id IN
        (SELECT id FROM projects WHERE cluster_key=?)`).run(repo.projectId,kind,bridge.git_branch ?? null,location,EXTERNAL_PROJECT_KEY);
      const row = db.prepare("SELECT id,project_id AS projectId,path FROM workspaces WHERE path=?").get(location) as AdoptionRoot;
      roots.push(row);
    }
  }
  const match = matchAdoptionRoot(canonicalWorkspacePath(cwd), roots);
  if (match) return match.id;
  db.prepare("INSERT OR IGNORE INTO projects (id,name,cluster_key,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run("as-external-project", "外部会话", EXTERNAL_PROJECT_KEY, now, now);
  const project = db.prepare("SELECT id FROM projects WHERE cluster_key=?").get(EXTERNAL_PROJECT_KEY) as {id:string};
  // A workspace per actual cwd keeps session operations tied to the real directory.
  db.prepare(`INSERT OR IGNORE INTO workspaces (id,project_id,name,path,kind,created_by,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), project.id, path.basename(cwd), cwd, "directory", "discovered", now);
  const workspace = db.prepare("SELECT id,project_id FROM workspaces WHERE path=?").get(cwd) as {id:string;project_id:string};
  // Scratch/home roots are deliberately not project ownership. Reuse an existing
  // exact workspace without moving other sessions out of their project.
  if (workspace.project_id !== project.id) return workspace.id;
  return workspace.id;
}

/** Transactional snapshot import: no daemon mutations, even for an empty thread. */
export function adoptSnapshot(snapshot: AttachResult, turns: Record<string, Turn> = {}, bridges: Parameters<typeof resolveAdoptionWorkspace>[1] = []) {
  if (!isAdoptEnabled()) return null;
  const db = getDB(), thread = snapshot.thread, daemon = daemonIdentity();
  const groups = adoptionTurns(snapshot, turns);
  return db.transaction(() => {
    let adopted = db.prepare("SELECT * FROM as_adoptions WHERE daemon_id=? AND thread_id=?").get(daemon, thread.id) as Adoption | null;
    if (adopted && !adopted.session_id) return null; // Permanent deletion tombstone.
    if (!adopted) {
      if (groups.length === 0) return null; // Keep observing until its first turn.
      if (thread.status.type === "closed" || hasAsThreadClaim(thread.clientThreadId) || db.prepare("SELECT 1 FROM as_threads WHERE daemon_id=? AND thread_id=?").get(daemon, thread.id)) return null;
      const id = randomUUID(), now = Date.now(), workspaceId = resolveAdoptionWorkspace(thread.cwd, bridges);
      db.prepare(`INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,context_mode,workspace_path,workspace_id,model,origin,binding_type,require_approval)
        VALUES (?,?,?,?,?,'project',?,?,?,'external','thread',1)`)
        .run(id, adoptionTitle(thread), "", now, now, thread.cwd, workspaceId,
          thread.backend === "codex" ? thread.model ? `codex:${thread.model}` : "codex" : thread.model ?? "claude-sonnet");
      bindAsThread(id, thread.id);
      db.prepare("INSERT INTO as_adoptions VALUES (?,?,?,?,?,?,?)").run(daemon, thread.id, id, thread.backend, thread.status.type, JSON.stringify(thread), now);
      adopted = {session_id:id,status:thread.status.type,metadata_json:""};
    }
    const sessionId = adopted.session_id!;
    let changed = adopted.metadata_json !== JSON.stringify(thread);
    const before = db.prepare("SELECT s.workspace_id,w.project_id FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?")
      .get(sessionId) as {workspace_id:string|null;project_id:string|null};
    const workspaceId = resolveAdoptionWorkspace(thread.cwd,bridges);
    const after = db.prepare("SELECT project_id FROM workspaces WHERE id=?").get(workspaceId) as {project_id:string};
    if (before.workspace_id !== workspaceId || before.project_id !== after.project_id) {
      db.prepare("UPDATE sessions SET workspace_id=? WHERE id=?").run(workspaceId,sessionId);
      changed = true;
    }
    let parent: string | null = null;
    for (const group of groups) {
      const {turn,items,question} = group;
      const existing = db.prepare("SELECT node_id FROM as_turns WHERE daemon_id=? AND thread_id=? AND turn_id=?").get(daemon, thread.id, turn.id) as {node_id:string} | null;
      let nodeId = existing?.node_id;
      if (!nodeId) {
        // The web start RPC may race turn/started before persisting turn_id.
        const pending = turn.clientTurnId ? db.prepare("SELECT node_id FROM as_turns WHERE daemon_id=? AND thread_id=? AND client_turn_id=?")
          .get(daemon, thread.id, turn.clientTurnId) as {node_id:string} | null : null;
        nodeId = pending?.node_id;
      }
      if (!nodeId) {
        nodeId = randomUUID();
        const args = {nodeId,question,now:turn.enqueuedAtMs};
        if (parent) createBranchNode({...args,parentId:parent,parentAnchor:null});
        else {
          createRootInSession({...args,sessionId});
          db.prepare("UPDATE sessions SET root_node_id=? WHERE id=? AND root_node_id=''").run(nodeId,sessionId);
        }
        bindAsTurn(nodeId,thread.id,turn.clientTurnId ?? `external-${turn.id}`);
        changed = true;
      }
      if (!parent) db.prepare("UPDATE sessions SET root_node_id=? WHERE id=? AND root_node_id=''").run(nodeId,sessionId);
      parent = nodeId;
      // A live ProjectRun owns incremental writes for this node. Its socket can
      // be ahead of this polling snapshot; never rewind it with older items.
      if (hasActiveProjectRun(nodeId)) continue;
      const node = getNode(nodeId)!;
      if (node.question === "外部操作" && question !== node.question && items.some(i => i.type === "userMessage")) {
        db.prepare("UPDATE nodes SET question=? WHERE id=?").run(question,nodeId);
        changed = true;
      }
      const {response,finalStart} = projectResponse(items);
      const calls = items.map(itemToolCall).filter(c => c !== null);
      for (const item of items) if (item.type === "subAgent") {
        const call = calls.find(c => c.id === item.payload.parentItemId);
        if (call) call.agent = {taskType:item.payload.kind === "agent" ? "local_agent" : item.payload.kind === "bash" ? "local_bash" : "local_workflow",phase:item.payload.phase,summary:item.payload.text};
      }
      const pending = snapshot.pendingRequests.find(r => r.params.turnId === turn.id);
      const interaction = pending ? projectInteraction(pending) : null;
      const status = ["queued","inProgress"].includes(turn.status) ? "streaming" : turn.status === "completed" ? "done" : "error";
      if (node.response !== response || JSON.stringify(node.toolCalls) !== JSON.stringify(calls) || node.status !== status || JSON.stringify(node.pendingInteraction) !== JSON.stringify(interaction)) {
        db.prepare("UPDATE nodes SET response=?,tool_calls_json=?,status=?,final_start=? WHERE id=?").run(response,JSON.stringify(calls),status,finalStart,nodeId);
        if (interaction) persistPendingInteraction(nodeId,interaction); else clearPendingInteraction(nodeId);
        if (status !== "streaming") finalizeNode({nodeId,status,errorMessage:status === "error" ? turn.error?.message ?? turn.status : undefined,
          tokenInput:turn.usage?.inputTokens ?? node.tokenCount.input,tokenOutput:turn.usage?.outputTokens ?? node.tokenCount.output,
          tokenCacheRead:turn.usage?.cachedTokens ?? node.tokenCount.cacheRead,tokenCacheCreation:turn.usage?.cacheCreation ?? node.tokenCount.cacheCreation,
          tokenContext:turn.usage?.contextTokens,finalStart,durationMs:turn.durationMs,now:Date.now()});
        changed = true;
      }
      updateAsTurn(nodeId,turn.id,items.filter(i => i.type !== "userMessage" && i.completedSeq).at(-1)?.id);
    }
    if (changed) {
      const now = Date.now();
      db.prepare("UPDATE as_adoptions SET status=?,metadata_json=?,updated_at=? WHERE daemon_id=? AND thread_id=?")
        .run(thread.status.type,JSON.stringify(thread),now,daemon,thread.id);
      db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(now,sessionId);
      db.prepare("UPDATE sessions SET title=? WHERE id=? AND title_source<>'user'").run(adoptionTitle(thread),sessionId);
    }
    return sessionId;
  })();
}

export class AdoptionService {
  private client?: AgentClient;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private scanning = false;
  private failures = 0;
  private turns: Record<string,Turn> = {};
  private attached = new Set<string>();
  constructor(private factory = () => createProjectClient({reconnect:false,observe:true})) {}
  stop() { this.stopped = true; clearTimeout(this.timer); this.client?.close(); this.client = undefined; this.attached.clear(); }
  async scan() {
    if (!isAdoptEnabled()) { this.stop(); return; }
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      if (!this.client) {
        const client = this.client = this.factory();
        for (const method of Object.keys(NotificationSchemas) as NotificationMethod[]) client.onNotification(method, params => {
          if (method === "turn/started" || method === "turn/completed") {
            const p = params as {turn:Turn}; this.turns[p.turn.id] = p.turn;
          }
          // Do not respond, lease, resume or close any observed thread.
          if (method === "serverRequest/resolved") {
            const p = params as {threadId:string;requestId:string;decidedBy:{label:string}};
            getDB().prepare(`UPDATE as_turns SET resolved_json=? WHERE daemon_id=? AND thread_id=? AND node_id IN
              (SELECT id FROM nodes WHERE json_extract(pending_interaction_json,'$.toolUseId')=?)`)
              .run(JSON.stringify([`已由 ${p.decidedBy.label} 处理`]),daemonIdentity(),p.threadId,p.requestId);
          }
        });
      }
      await this.client.connect();
      let cursor: string | undefined;
      const threads: Thread[] = [];
      do {
        if (!isAdoptEnabled()) { this.stop(); return; }
        const page = await this.client.request("thread/list",{limit:200,cursor});
        threads.push(...page.threads); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const { getHerdrFleetService } = await import("./herdr-fleet");
      const bridges = getHerdrFleetService().fleet().workspaces.map(w => w.worktree).filter(Boolean) as Parameters<typeof resolveAdoptionWorkspace>[1];
      for (const thread of threads) {
        if (!isAdoptEnabled()) { this.stop(); return; }
        const adoption = getDB().prepare("SELECT * FROM as_adoptions WHERE daemon_id=? AND thread_id=?").get(daemonIdentity(),thread.id) as Adoption | null;
        if (adoption && !adoption.session_id) {
          if (this.attached.delete(thread.id)) await this.client.request("thread/detach",{threadId:thread.id});
          continue;
        }
        if (!adoption && (thread.status.type === "closed" || hasAsThreadClaim(thread.clientThreadId) || getDB().prepare("SELECT 1 FROM as_threads WHERE daemon_id=? AND thread_id=?").get(daemonIdentity(),thread.id))) continue;
        const snapshot = await this.client.request("thread/attach",{threadId:thread.id,sinceSeq:0});
        this.attached.add(thread.id);
        adoptSnapshot(snapshot,this.turns,bridges);
      }
      this.failures = 0;
    } catch (error) {
      this.client?.close(); this.client = undefined;
      this.attached.clear();
      this.failures++;
      console.warn(`[trellis/as-adopt] ${error}`);
    } finally {
      this.scanning = false;
      if (!this.stopped && isAdoptEnabled()) {
        this.timer = setTimeout(() => void this.scan(), this.failures ? Math.min(30000,1000*2**this.failures) : 1500);
        this.timer.unref?.();
      }
    }
  }
}
const globalAdoption = globalThis as typeof globalThis & {trellisAdoption?:AdoptionService};
export function startAdoption() {
  if (!isAdoptEnabled() || globalAdoption.trellisAdoption) return;
  const service = globalAdoption.trellisAdoption = new AdoptionService();
  void service.scan();
}
