"use client";

import { useEffect, useMemo, useState } from "react";
import { buildHerdrSessionStatusMap } from "@/lib/herdr-ui";
import type {
  HerdrFleetResponse,
  HerdrHookRecord,
} from "@/lib/herdr-ui";
import { pageEvents } from "@/lib/page-events";
import {
  herdrFetchPlan,
  herdrPollInterval,
  type HerdrChangeEvent,
  type HerdrFetchPlan,
} from "@/lib/herdr-push";

export type HerdrFleetSnapshot = {
  fleet: HerdrFleetResponse | null;
  hooks: HerdrHookRecord[];
  loading: boolean;
  error: string | null;
};

export function herdrUnavailableText({ fleet, loading, error }: Pick<HerdrFleetSnapshot, "fleet" | "loading" | "error">): string {
  if (loading) return "正在连接 Herdr…";
  if (fleet?.enabled === false) return "Herdr 未启用";
  if (/\b(?:ENOENT|ECONNREFUSED)\b/.test(fleet?.lastError || error || "")) return "Herdr 未运行";
  return "Herdr 暂时无法连接";
}

// 数据来源：服务端一有变化（Herdr 事件 / hook 写入 / transcript 镜像 / 输入投递）就在
// 统一事件流 /api/events 的 `herdr` 通道推一条 { fleetEtag, hooksEtag }，这里比对 ETag
// 后只拉变了的那一半（If-None-Match）。轮询只是兜底：流在线 30s，断流时回到 2.5s；
// 每次（重）连上立刻拉一次全量，补上断线期间错过的变化。
let snapshot: HerdrFleetSnapshot = {
  fleet: null,
  hooks: [],
  loading: true,
  error: null,
};
let etag: string | null = null;
let hooksEtag: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let timerMs = 0;
let inFlight: Promise<void> | null = null;
let queued: HerdrFetchPlan | null = null;
let streamConnected = false;
let detachStream: (() => void) | null = null;
const listeners = new Set<(next: HerdrFleetSnapshot) => void>();

function publish(next: HerdrFleetSnapshot): void {
  const diagnostic = next.fleet?.lastError || next.error;
  if (diagnostic && diagnostic !== (snapshot.fleet?.lastError || snapshot.error)) {
    console.warn("[Herdr]", diagnostic);
  }
  snapshot = next;
  for (const listener of listeners) listener(next);
}

async function fetchOnce(plan: HerdrFetchPlan): Promise<void> {
  try {
    const [fleetResponse, hooksResponse] = await Promise.all([
      plan.fleet
        ? fetch("/api/herdr/fleet", { cache: "no-store", headers: etag ? { "If-None-Match": etag } : undefined })
        : null,
      plan.hooks
        ? fetch("/api/hooks/state", { cache: "no-store", headers: hooksEtag ? { "If-None-Match": hooksEtag } : undefined })
        : null,
    ]);
    if (fleetResponse && !fleetResponse.ok && fleetResponse.status !== 304) {
      throw new Error(`Herdr fleet HTTP ${fleetResponse.status}`);
    }
    if (hooksResponse && !hooksResponse.ok && hooksResponse.status !== 304) {
      throw new Error(`hook state HTTP ${hooksResponse.status}`);
    }
    let fleet = snapshot.fleet;
    if (fleetResponse && fleetResponse.status !== 304) {
      fleet = (await fleetResponse.json()) as HerdrFleetResponse;
      etag = fleetResponse.headers.get("etag");
    }
    // Refresh the projection on a 304 too: waiting-hook TTLs can expire
    // even when neither server-side record nor fleet ETag changed.
    let hooks = [...snapshot.hooks];
    if (hooksResponse && hooksResponse.status !== 304) {
      hooks = ((await hooksResponse.json()) as { records?: HerdrHookRecord[] }).records ?? [];
      hooksEtag = hooksResponse.headers.get("etag");
    }
    publish({ fleet, hooks, loading: false, error: null });
  } catch (error) {
    publish({
      ...snapshot,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 串行拉取：在途时把新需求并进下一轮（推送密集时最多一个在途 + 一个排队）。 */
function poll(plan: HerdrFetchPlan = { fleet: true, hooks: true }): Promise<void> {
  if (inFlight) {
    queued = { fleet: plan.fleet || Boolean(queued?.fleet), hooks: plan.hooks || Boolean(queued?.hooks) };
    return inFlight;
  }
  inFlight = (async () => {
    let next: HerdrFetchPlan | null = plan;
    while (next) {
      await fetchOnce(next);
      next = queued;
      queued = null;
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function schedulePolling(): void {
  const ms = herdrPollInterval(streamConnected);
  if (timer && timerMs === ms) return;
  if (timer) clearInterval(timer);
  timerMs = ms;
  timer = setInterval(() => void poll(), ms);
}

function attachStream(): () => void {
  const stream = pageEvents();
  const offChange = stream.on("herdr", (data) => {
    const plan = herdrFetchPlan(data as HerdrChangeEvent, { fleetEtag: etag, hooksEtag });
    if (plan) void poll(plan);
  });
  const offStatus = stream.onStatus(({ connected }) => {
    streamConnected = connected;
    schedulePolling();
    if (connected) void poll();
  });
  streamConnected = stream.connected;
  return () => { offChange(); offStatus(); };
}

function subscribe(listener: (next: HerdrFleetSnapshot) => void): () => void {
  listeners.add(listener);
  listener(snapshot);
  if (listeners.size === 1) {
    detachStream = attachStream();
    void poll();
    schedulePolling();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      timerMs = 0;
      detachStream?.();
      detachStream = null;
    }
  };
}

export function refreshHerdrFleet(): Promise<void> {
  return poll();
}

export function useHerdrFleet(): HerdrFleetSnapshot {
  const [state, setState] = useState(snapshot);
  useEffect(() => subscribe(setState), []);
  return state;
}

/** Sidebar projection. Full fleet consumers remain in the in-session controls. */
export function useHerdrSessionStatuses() {
  const state = useHerdrFleet();
  const statuses = useMemo(() => buildHerdrSessionStatusMap(state.fleet, state.hooks, state.error), [state.fleet, state.hooks, state.error]);
  return { statuses, available: Boolean(state.fleet?.available && !state.error), unavailableText: herdrUnavailableText(state) };
}
