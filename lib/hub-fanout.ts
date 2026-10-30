import { viaFetch } from "./gw-client";
import type { GwNode } from "./gw-types";
import type { PendingItem } from "./pending";

// 跨机汇总（hub 多机互联）：列机器 + 并发 viaFetch + 每台超时 / 失败隔离，以及把各台结果
// 合并成侧栏「其他机器」收件箱、搜索「所有机器」分组的纯逻辑。网络部分可注入 fetcher，
// 合并 / 排序都是纯函数（hub-fanout.test.ts）。
//
// 口径：「其他机器」= hub 报的 nodes 里 current=false 的那些（含 hub 本机，如果当前在远端）；
// 当前机器自己的待处理 / 在跑已经在侧栏「等你处理」与行首状态槽里，这里不重复。
// 只有至少一台 kind=remote 时才算多机（与 NodeSwitcher 同一判定）。

export type FanoutResult<T> =
  | { node: string; status: "ok"; data: T }
  | { node: string; status: "offline" }
  | { node: string; status: "error"; error: string };

export type Fetcher = (node: string, apiPath: string, init?: RequestInit) => Promise<Response>;

export const FANOUT_TIMEOUT_MS = 8_000;

export function isMultiNode(nodes: GwNode[] | null | undefined): nodes is GwNode[] {
  return !!nodes && nodes.some((n) => n.kind === "remote");
}

export function otherNodes(nodes: GwNode[] | null | undefined): GwNode[] {
  return isMultiNode(nodes) ? nodes.filter((n) => !n.current) : [];
}

// 并发打每台机器的同一个 /api 路径。离线机器不发请求直接记 offline；每台独立超时，
// 某台挂了 / 超时 / 返回非 JSON 只影响它自己那一项。结果顺序 = 传入 nodes 的顺序。
export async function fanOut<T>(
  nodes: GwNode[],
  apiPath: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    fetcher?: Fetcher;
    parse?: (json: unknown) => T;
  } = {},
): Promise<FanoutResult<T>[]> {
  const { timeoutMs = FANOUT_TIMEOUT_MS, signal, fetcher = viaFetch, parse = (j) => j as T } = opts;
  return Promise.all(
    nodes.map(async (n): Promise<FanoutResult<T>> => {
      if (!n.online) return { node: n.name, status: "offline" };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      try {
        const res = await fetcher(n.name, apiPath, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (res.status === 503) {
          // 网关在 hub 列表与真实隧道之间有时间差：via 报离线就按离线处理。
          const body = (await res.json().catch(() => null)) as { offline?: boolean } | null;
          if (body?.offline) return { node: n.name, status: "offline" };
        }
        if (!res.ok) return { node: n.name, status: "error", error: `HTTP ${res.status}` };
        return { node: n.name, status: "ok", data: parse(await res.json()) };
      } catch (e) {
        const msg = controller.signal.aborted && !signal?.aborted ? "超时" : e instanceof Error ? e.message : String(e);
        return { node: n.name, status: "error", error: msg };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }),
  );
}

// ── 收件箱 ───────────────────────────────────────────────────────────────────

/** /api/runs 里收件箱用得到的部分。 */
export type RunsPayload = {
  pending?: { items?: PendingItem[] };
  runningNodes?: { nodeId: string; sessionId: string }[];
  waitingNodes?: { nodeId: string; sessionId: string }[];
};

/** /api/sessions 里收件箱用得到的部分（sessions ∪ taskSessions）。 */
export type SessionLite = { id: string; title: string; updatedAt: number; archived?: boolean };

export type InboxStatus = "waiting" | "running" | "done";

export type InboxItem = {
  node: string;
  sessionId: string;
  /** 能定位到的节点（等待中的那一轮 / 在跑的那一轮）；刚完成的只到会话。 */
  nodeId: string | null;
  title: string;
  status: InboxStatus;
  /** 等待 = 提问 / 审批的说明；其它为空。 */
  summary?: string;
  kind?: "approval" | "question";
  at: number;
};

export type InboxNode =
  | { node: string; status: "ok"; items: InboxItem[] }
  | { node: string; status: "offline" | "error"; error?: string };

/** 「刚完成」窗口：会话最近一次更新在这之内、且已不在跑 / 不在等。 */
export const DONE_WINDOW_MS = 30 * 60_000;
export const DONE_MAX_PER_NODE = 3;

const RANK: Record<InboxStatus, number> = { waiting: 0, running: 1, done: 2 };

// 单台机器：等你回答（pending 快照 ∪ run-bus waiting）> 在跑 > 刚完成。一个会话只出现一次，
// 取最紧急的状态。标题优先 sessions 列表，其次 pending 自带的 sessionTitle。
export function buildNodeInbox(
  node: string,
  runs: RunsPayload,
  sessions: SessionLite[] | undefined,
  now: number,
  opts: { doneWindowMs?: number; doneMax?: number } = {},
): InboxItem[] {
  const { doneWindowMs = DONE_WINDOW_MS, doneMax = DONE_MAX_PER_NODE } = opts;
  const byId = new Map((sessions ?? []).map((s) => [s.id, s]));
  const titleOf = (id: string, fallback?: string) => byId.get(id)?.title || fallback || "未命名会话";
  const out = new Map<string, InboxItem>();

  const pending = [...(runs.pending?.items ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  for (const p of pending) {
    if (out.has(p.sessionId)) continue;
    out.set(p.sessionId, {
      node, sessionId: p.sessionId, nodeId: p.nodeId, title: titleOf(p.sessionId, p.sessionTitle),
      status: "waiting", summary: p.summary, kind: p.kind, at: p.createdAt,
    });
  }
  for (const w of runs.waitingNodes ?? []) {
    if (out.has(w.sessionId)) continue;
    out.set(w.sessionId, {
      node, sessionId: w.sessionId, nodeId: w.nodeId, title: titleOf(w.sessionId),
      status: "waiting", at: byId.get(w.sessionId)?.updatedAt ?? now,
    });
  }
  for (const r of runs.runningNodes ?? []) {
    if (out.has(r.sessionId)) continue;
    out.set(r.sessionId, {
      node, sessionId: r.sessionId, nodeId: r.nodeId, title: titleOf(r.sessionId),
      status: "running", at: byId.get(r.sessionId)?.updatedAt ?? now,
    });
  }
  if (sessions) {
    const done = sessions
      .filter((s) => !s.archived && !out.has(s.id) && now - s.updatedAt <= doneWindowMs && s.updatedAt <= now + 60_000)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, doneMax);
    for (const s of done) {
      out.set(s.id, { node, sessionId: s.id, nodeId: null, title: s.title || "未命名会话", status: "done", at: s.updatedAt });
    }
  }
  return [...out.values()];
}

// 跨机排序：状态紧急度优先；同状态里等待按最早发起在前（等得最久的先处理），
// 在跑 / 刚完成按最近在前；再按机器名、会话 id 稳定。
export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      (a.status === "waiting" ? a.at - b.at : b.at - a.at) ||
      a.node.localeCompare(b.node) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

export function mergeInbox(nodes: InboxNode[]): { items: InboxItem[]; unavailable: InboxNode[] } {
  const items = nodes.flatMap((n) => (n.status === "ok" ? n.items : []));
  return { items: sortInbox(items), unavailable: nodes.filter((n) => n.status !== "ok") };
}

// 远端会话的页面地址（app/page.tsx 深链：/?session=<sid>&node=<nid>），交给 goHref 整页切机器。
export function sessionPath(sessionId: string, nodeId?: string | null): string {
  const q = new URLSearchParams({ session: sessionId });
  if (nodeId) q.set("node", nodeId);
  return `/?${q.toString()}`;
}

// ── 搜索 ─────────────────────────────────────────────────────────────────────

export type SearchGroup<R> =
  | { node: string; local: boolean; status: "ok"; results: R[] }
  | { node: string; local: boolean; status: "offline" | "error"; error?: string };

// 搜索分组：本机在最前，其余按 hub 列表顺序；没命中的远端机器整组不出现（只剩噪音），
// 离线 / 出错的保留一行灰态，用户知道「那台没搜到」不等于「那台没有」。
export function groupSearch<R>(
  local: { node: string; results: R[] } | null,
  remote: FanoutResult<{ results?: R[] }>[],
): SearchGroup<R>[] {
  const groups: SearchGroup<R>[] = [];
  if (local) groups.push({ node: local.node, local: true, status: "ok", results: local.results });
  for (const r of remote) {
    if (r.status === "ok") {
      const results = r.data?.results ?? [];
      if (results.length) groups.push({ node: r.node, local: false, status: "ok", results });
    } else {
      groups.push({ node: r.node, local: false, status: r.status, error: r.status === "error" ? r.error : undefined });
    }
  }
  return groups;
}
