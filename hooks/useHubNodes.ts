"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchNodes } from "@/lib/gw-client";
import type { GwNode } from "@/lib/gw-types";
import {
  buildNodeInbox,
  fanOut,
  isMultiNode,
  otherNodes,
  type InboxNode,
  type RunsPayload,
  type SessionLite,
} from "@/lib/hub-fanout";

// hub 机器列表的全站共享订阅：侧栏收件箱、搜索「所有机器」共用一份，一个轮询。
// 直连单人版时 /__gw/api/nodes 是 404 → 值为 null，所有跨机 UI 都不出现。
// （NodeSwitcher 仍自带轮询，没并进来——它不在本次改动范围。）

const NODES_POLL_MS = 30_000;

let nodesValue: GwNode[] | null = null;
let nodesLoaded = false;
let nodesInflight: Promise<void> | null = null;
let nodesTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function refreshHubNodes(): Promise<void> {
  if (nodesInflight) return nodesInflight;
  nodesInflight = fetchNodes()
    .then((n) => { nodesValue = n; })
    .catch(() => { nodesValue = null; })
    .finally(() => {
      nodesLoaded = true;
      nodesInflight = null;
      emit();
    });
  return nodesInflight;
}

function onVisibility() {
  if (document.visibilityState === "visible") void refreshHubNodes();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (listeners.size === 1) {
    if (!nodesLoaded) void refreshHubNodes();
    nodesTimer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshHubNodes();
    }, NODES_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (nodesTimer) clearInterval(nodesTimer);
      nodesTimer = null;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

export function useHubNodes(): GwNode[] | null {
  return useSyncExternalStore(subscribe, () => nodesValue, () => null);
}

/** 其他机器（非当前）；不是多机（直连 / 只有 hub 本机）时为空数组。 */
export function useOtherNodes(): GwNode[] {
  const nodes = useHubNodes();
  return isMultiNode(nodes) ? otherNodes(nodes) : EMPTY;
}
const EMPTY: GwNode[] = [];

// ── 收件箱轮询 ───────────────────────────────────────────────────────────────
// /api/runs 轻（内存快照），每 20s 一轮；/api/sessions 重（整张列表 + 项目树），每台机器
// 缓存 2 分钟，出现不认识的在跑 / 等待会话（要它的标题）或上一轮在跑的会话停了（要「刚完成」）
// 时提前刷新。页面隐藏时整体停，
// 回到前台立刻补一轮。某台失败只把它那一行变灰。

const INBOX_POLL_MS = 20_000;
const SESSIONS_TTL_MS = 120_000;

type SessionsCache = { at: number; list: SessionLite[] };

const activeIds = (runs: RunsPayload) =>
  new Set([...(runs.runningNodes ?? []), ...(runs.waitingNodes ?? [])].map((r) => r.sessionId));

function sessionsStale(runs: RunsPayload, cache: SessionsCache | undefined, prevActive: Set<string> | undefined, now: number): boolean {
  if (!cache || now - cache.at > SESSIONS_TTL_MS) return true;
  const known = new Set(cache.list.map((s) => s.id));
  const active = activeIds(runs);
  if ([...active].some((id) => !known.has(id))) return true;
  return !!prevActive && [...prevActive].some((id) => !active.has(id));
}

export function useHubInbox(): InboxNode[] | null {
  const others = useOtherNodes();
  const [inbox, setInbox] = useState<InboxNode[] | null>(null);
  const sessionsCache = useRef(new Map<string, SessionsCache>());
  const prevActive = useRef(new Map<string, Set<string>>());
  const othersKey = others.map((n) => `${n.name}:${n.online ? 1 : 0}`).join(",");
  const othersRef = useRef(others);
  useEffect(() => { othersRef.current = others; });

  const load = useCallback(async (signal: AbortSignal) => {
    const nodes = othersRef.current;
    if (nodes.length === 0) return;
    const runs = await fanOut<RunsPayload>(nodes, "/api/runs", { signal });
    // 第二跳只打需要刷新标题 / 刚完成列表的机器
    const now = Date.now();
    const stale = nodes.filter((n, i) => {
      const r = runs[i];
      if (r.status !== "ok") return false;
      const stale = sessionsStale(r.data, sessionsCache.current.get(n.name), prevActive.current.get(n.name), now);
      prevActive.current.set(n.name, activeIds(r.data));
      return stale;
    });
    if (stale.length) {
      const lists = await fanOut<SessionLite[]>(stale, "/api/sessions", {
        signal,
        parse: (j) => {
          const d = j as { sessions?: SessionLite[]; taskSessions?: SessionLite[] };
          return [...(d.sessions ?? []), ...(d.taskSessions ?? [])].map(({ id, title, updatedAt, archived }) => ({ id, title, updatedAt, archived }));
        },
      });
      for (const l of lists) if (l.status === "ok") sessionsCache.current.set(l.node, { at: Date.now(), list: l.data });
    }
    if (signal.aborted) return;
    setInbox(runs.map((r): InboxNode => r.status === "ok"
      ? { node: r.node, status: "ok", items: buildNodeInbox(r.node, r.data, sessionsCache.current.get(r.node)?.list, Date.now()) }
      : { node: r.node, status: r.status, error: r.status === "error" ? r.error : undefined }));
  }, []);

  useEffect(() => {
    if (!othersKey) {
      void Promise.resolve().then(() => setInbox(null));
      return;
    }
    let controller = new AbortController();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      controller.abort();
      controller = new AbortController();
      void load(controller.signal);
    };
    void Promise.resolve().then(tick);
    const id = setInterval(tick, INBOX_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      controller.abort();
    };
  }, [othersKey, load]);

  return othersKey ? inbox : null;
}


// ── 会话接力 ─────────────────────────────────────────────────────────────────

/** 当前机器 + 其余在线机器；不在 hub 后面 / 没有别的在线机器时 others 为空。 */
export function relayTargetsOf(list: GwNode[] | null): { current: GwNode | null; others: GwNode[] } {
  if (!list) return { current: null, others: [] };
  const current = list.find((n) => n.current) ?? null;
  return { current, others: list.filter((n) => !n.current && n.online) };
}

/** 「接力到其他机器…」菜单项是否该出现：经 hub、且至少有一台别的在线机器。 */
export function useCanRelay(): boolean {
  const list = useHubNodes();
  const { current, others } = relayTargetsOf(list);
  return !!current && others.length > 0;
}
