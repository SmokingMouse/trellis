import "server-only";
import { randomUUID } from "node:crypto";
import { getDB } from "@/lib/server/sqlite";
import { getSession } from "@/lib/server/repo";
import { getAgent } from "@/lib/server/agents";
import { getTask, listTriggers } from "@/lib/server/tasks";
import * as agentsRoute from "@/app/api/agents/route";
import * as agentRoute from "@/app/api/agents/[id]/route";
import * as tasksRoute from "@/app/api/tasks/route";
import * as taskRoute from "@/app/api/tasks/[id]/route";
import * as triggersRoute from "@/app/api/tasks/[id]/triggers/route";
import {
  BUTLER_AGENT_ID,
  confirmPhrase,
  type ButlerChange,
  type ButlerChangeKind,
  type ButlerChangeStatus,
} from "@/lib/butler";

// 管家改动提案。核心取舍：**确认后进程内重放原路由**，不另写一套落库逻辑 ——
// 路由里的校验（cron 合法性、防自触发、slug 冲突、内置拒删……）一行不漏地生效，
// 提案与 trellisctl 直连走的是同一条代码路径。

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

type Matched = {
  kind: ButlerChangeKind;
  id: string | null;
  triggerId: string | null;
  handler: Handler;
};

const noCtx = { params: Promise.resolve({ id: "" }) };

/** 只认这 8 种配置写；其余（tasks run、sessions rm…）不是配置变更，不进提案。 */
export function matchRoute(method: string, rawPath: string): Matched | null {
  const url = new URL(rawPath, "http://internal");
  const seg = url.pathname.split("/").filter(Boolean); // ["api","agents",...]
  if (seg[0] !== "api") return null;
  const m = method.toUpperCase();
  if (seg[1] === "agents") {
    if (seg.length === 2 && m === "POST") return { kind: "agent.create", id: null, triggerId: null, handler: agentsRoute.POST as Handler };
    if (seg.length === 3 && m === "PATCH") return { kind: "agent.update", id: seg[2], triggerId: null, handler: agentRoute.PATCH };
    if (seg.length === 3 && m === "DELETE") return { kind: "agent.delete", id: seg[2], triggerId: null, handler: agentRoute.DELETE as Handler };
  }
  if (seg[1] === "tasks") {
    if (seg.length === 2 && m === "POST") return { kind: "task.create", id: null, triggerId: null, handler: tasksRoute.POST as Handler };
    if (seg.length === 3 && m === "PATCH") return { kind: "task.update", id: seg[2], triggerId: null, handler: taskRoute.PATCH };
    if (seg.length === 3 && m === "DELETE") return { kind: "task.delete", id: seg[2], triggerId: null, handler: taskRoute.DELETE as Handler };
    if (seg.length === 4 && seg[3] === "triggers" && m === "POST") return { kind: "trigger.add", id: seg[2], triggerId: null, handler: triggersRoute.POST };
    if (seg.length === 4 && seg[3] === "triggers" && m === "DELETE") {
      return { kind: "trigger.remove", id: seg[2], triggerId: url.searchParams.get("triggerId"), handler: triggersRoute.DELETE as Handler };
    }
  }
  return null;
}

async function dispatch(
  matched: Matched,
  method: string,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const req = new Request(new URL(path, "http://internal"), {
    method,
    headers: body === undefined || body === null ? undefined : { "content-type": "application/json" },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  const res = await matched.handler(req, matched.id ? { params: Promise.resolve({ id: matched.id }) } : noCtx);
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON 响应 */
  }
  return { ok: res.ok, status: res.status, json };
}

/** 目标对象当前的样子 + 人读名。不存在 → before=null（PATCH/DELETE 会在应用时由路由报 404）。 */
function snapshot(m: Matched, body: Record<string, unknown> | null): { before: Record<string, unknown> | null; label: string } {
  switch (m.kind) {
    case "agent.create":
      return { before: null, label: String(body?.name ?? body?.slug ?? "新 Agent") };
    case "agent.update":
    case "agent.delete": {
      const a = m.id ? getAgent(m.id) : null;
      return { before: a ? { ...a } : null, label: a ? a.name : `Agent ${m.id}` };
    }
    case "task.create":
      return { before: null, label: String(body?.name ?? "新任务") };
    case "task.update":
    case "task.delete": {
      const t = m.id ? getTask(m.id) : null;
      return {
        before: t ? { ...t, triggers: listTriggers(t.id).length } : null,
        label: t ? t.name : `任务 ${m.id}`,
      };
    }
    case "trigger.add": {
      const t = m.id ? getTask(m.id) : null;
      return { before: null, label: `${t?.name ?? `任务 ${m.id}`} · ${String(body?.kind ?? "")} 触发器` };
    }
    case "trigger.remove": {
      const t = m.id ? getTask(m.id) : null;
      const tr = m.triggerId ? listTriggers(m.id ?? undefined).find((x) => x.id === m.triggerId) : undefined;
      return {
        before: tr ? { kind: tr.kind, config: tr.config, enabled: tr.enabled } : null,
        label: `${t?.name ?? `任务 ${m.id}`} · ${tr?.kind ?? ""} 触发器`,
      };
    }
  }
}

const HIGH_RISK = new Set<ButlerChangeKind>(["agent.delete", "task.delete"]);

type Row = {
  id: string; session_id: string; node_id: string | null; method: string; path: string;
  body_json: string | null; kind: ButlerChangeKind; target_id: string | null; target_label: string;
  risk: "normal" | "high"; status: ButlerChangeStatus; before_json: string | null;
  result_json: string | null; error: string | null; created_at: number;
  decided_at: number | null; reverted_at: number | null;
};

const parse = (s: string | null) => (s ? (JSON.parse(s) as Record<string, unknown>) : null);

function toChange(r: Row): ButlerChange {
  const c: ButlerChange = {
    id: r.id, sessionId: r.session_id, nodeId: r.node_id, method: r.method, path: r.path,
    body: parse(r.body_json), kind: r.kind, targetId: r.target_id, targetLabel: r.target_label,
    risk: r.risk, status: r.status, before: parse(r.before_json), result: parse(r.result_json),
    error: r.error, createdAt: r.created_at, decidedAt: r.decided_at, revertedAt: r.reverted_at,
    revertible: false,
  };
  c.revertible = c.status === "applied" && inverseOf(c) !== null;
  return c;
}

export function getChange(id: string): ButlerChange | null {
  const r = getDB().prepare("SELECT * FROM butler_changes WHERE id = ?").get(id) as Row | undefined;
  return r ? toChange(r) : null;
}

export function listChanges(opts: { sessionId?: string; decidedOnly?: boolean; limit?: number }): ButlerChange[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.sessionId) {
    where.push("session_id = ?");
    args.push(opts.sessionId);
  }
  if (opts.decidedOnly) where.push("status IN ('applied','reverted')");
  const order = opts.decidedOnly ? "COALESCE(reverted_at, decided_at) DESC" : "created_at ASC";
  args.push(opts.limit ?? 200);
  const rows = getDB()
    .prepare(`SELECT * FROM butler_changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`)
    .all(...args) as Row[];
  return rows.map(toChange);
}

export class ChangeError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * 提案入口。返回 null = 这不是管家会话（调用方照常直连）；抛 ChangeError = 是管家
 * 会话但这个写请求不在白名单（管家不该用 trellisctl 以外的方式写配置）。
 */
export function proposeChange(input: {
  sessionId: string;
  nodeId?: string | null;
  method: string;
  path: string;
  body?: unknown;
}): ButlerChange | null {
  const session = getSession(input.sessionId);
  if (!session || session.agentId !== BUTLER_AGENT_ID) return null;
  const matched = matchRoute(input.method, input.path);
  if (!matched) throw new ChangeError(`管家不能直接做这个写操作：${input.method} ${input.path}`);
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : null;
  const { before, label } = snapshot(matched, body);
  if (matched.kind.endsWith(".update") || matched.kind.endsWith(".delete")) {
    if (!before) throw new ChangeError(`找不到要改的对象：${input.path}`, 404);
  }
  const id = randomUUID();
  getDB()
    .prepare(
      `INSERT INTO butler_changes
         (id, session_id, node_id, method, path, body_json, kind, target_id, target_label, risk, status, before_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id, input.sessionId, input.nodeId ?? null, input.method.toUpperCase(), input.path,
      body ? JSON.stringify(body) : null, matched.kind, matched.triggerId ?? matched.id,
      label, HIGH_RISK.has(matched.kind) ? "high" : "normal",
      before ? JSON.stringify(before) : null, Date.now(),
    );
  return getChange(id);
}

function setStatus(id: string, patch: Partial<Pick<Row, "status" | "before_json" | "result_json" | "error" | "decided_at" | "reverted_at">>) {
  const keys = Object.keys(patch);
  getDB()
    .prepare(`UPDATE butler_changes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null), id);
}

export async function applyChange(id: string, opts: { confirm?: string } = {}): Promise<ButlerChange> {
  const c = getChange(id);
  if (!c) throw new ChangeError("没有这条提案", 404);
  if (c.status !== "pending") throw new ChangeError(`这条提案已经是 ${c.status}`, 409);
  if (c.risk === "high" && opts.confirm !== confirmPhrase(c)) {
    throw new ChangeError(`高危改动要输入「${confirmPhrase(c)}」确认`, 403);
  }
  const matched = matchRoute(c.method, c.path)!;
  // 应用那一刻重新取快照 —— 提案之后对象可能被别处改过，撤销要回到「应用前」而不是「提案时」。
  const { before } = snapshot(matched, c.body);
  const r = await dispatch(matched, c.method, c.path, c.body);
  const now = Date.now();
  if (!r.ok) {
    setStatus(id, { status: "failed", error: String(r.json?.error ?? `HTTP ${r.status}`), decided_at: now });
  } else {
    setStatus(id, {
      status: "applied",
      before_json: before ? JSON.stringify(before) : c.before ? JSON.stringify(c.before) : null,
      result_json: r.json ? JSON.stringify(r.json) : null,
      decided_at: now,
    });
  }
  return getChange(id)!;
}

export function rejectChange(id: string): ButlerChange {
  const c = getChange(id);
  if (!c) throw new ChangeError("没有这条提案", 404);
  if (c.status !== "pending") throw new ChangeError(`这条提案已经是 ${c.status}`, 409);
  setStatus(id, { status: "rejected", decided_at: Date.now() });
  return getChange(id)!;
}

/** 逆请求：create → 删掉建出来的；update → 把改过的字段写回旧值；trigger 增删互逆；删除不可逆。 */
export function inverseOf(c: ButlerChange): { method: string; path: string; body: unknown } | null {
  const created = (key: string) => (c.result?.[key] as { id?: string } | undefined)?.id ?? null;
  switch (c.kind) {
    case "agent.create": {
      const id = created("agent");
      return id ? { method: "DELETE", path: `/api/agents/${id}`, body: null } : null;
    }
    case "task.create": {
      const id = created("task");
      return id ? { method: "DELETE", path: `/api/tasks/${id}`, body: null } : null;
    }
    case "agent.update":
    case "task.update": {
      if (!c.before || !c.body) return null;
      const back: Record<string, unknown> = {};
      for (const k of Object.keys(c.body)) back[k] = c.before[k] ?? null;
      return { method: "PATCH", path: c.path, body: back };
    }
    case "trigger.add": {
      const tid = created("trigger");
      return tid ? { method: "DELETE", path: `/api/tasks/${c.path.split("/")[3]}/triggers?triggerId=${tid}`, body: null } : null;
    }
    case "trigger.remove":
      return c.before
        ? { method: "POST", path: c.path.split("?")[0], body: { kind: c.before.kind, config: c.before.config } }
        : null;
    default:
      return null;
  }
}

export async function revertChange(id: string): Promise<ButlerChange> {
  const c = getChange(id);
  if (!c) throw new ChangeError("没有这条提案", 404);
  if (c.status !== "applied") throw new ChangeError("只有已应用的改动能撤销", 409);
  const inv = inverseOf(c);
  if (!inv) throw new ChangeError("这条改动不可撤销", 409);
  const matched = matchRoute(inv.method, inv.path);
  if (!matched) throw new ChangeError("构造不出逆操作", 500);
  const r = await dispatch(matched, inv.method, inv.path, inv.body);
  if (!r.ok) throw new ChangeError(`撤销失败：${String(r.json?.error ?? `HTTP ${r.status}`)}`, 409);
  setStatus(id, { status: "reverted", reverted_at: Date.now() });
  return getChange(id)!;
}
