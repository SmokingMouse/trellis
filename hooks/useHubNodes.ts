"use client";
import { useEffect, useSyncExternalStore } from "react";
import { fetchNodes } from "@/lib/gw-client";
import type { GwNode } from "@/lib/gw-types";

// hub 机器列表的进程内共享缓存：菜单项（顶栏 / 手机溢出菜单 / 侧栏每一行）都要判断
// 「有没有别的在线机器」，各自拉一遍 /__gw/api/nodes 太浪费。null = 不在 hub 后面
// （直连单机版 404）或还没拉到。STALE_MS 内重复订阅不再发请求；refreshHubNodes 强制刷新。

const STALE_MS = 30_000;

let nodes: GwNode[] | null = null;
let fetchedAt = 0;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function refreshHubNodes(force = true): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - fetchedAt < STALE_MS) return Promise.resolve();
  inflight = fetchNodes()
    .then((list) => {
      nodes = list;
    })
    .catch(() => {
      nodes = null;
    })
    .finally(() => {
      fetchedAt = Date.now();
      inflight = null;
      emit();
    });
  return inflight;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useHubNodes(): GwNode[] | null {
  const snapshot = useSyncExternalStore(subscribe, () => nodes, () => null);
  useEffect(() => {
    void refreshHubNodes(false);
  }, []);
  return snapshot;
}

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
