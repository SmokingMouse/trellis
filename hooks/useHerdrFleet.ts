"use client";

import { useEffect, useMemo, useState } from "react";
import { buildHerdrSessionStatusMap } from "@/lib/herdr-ui";
import type {
  HerdrFleetResponse,
  HerdrHookRecord,
} from "@/lib/herdr-ui";

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

const POLL_MS = 2_500;
let snapshot: HerdrFleetSnapshot = {
  fleet: null,
  hooks: [],
  loading: true,
  error: null,
};
let etag: string | null = null;
let hooksEtag: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let events: EventSource | null = null;
let eventVersion = 0;
const listeners = new Set<(next: HerdrFleetSnapshot) => void>();

function publish(next: HerdrFleetSnapshot): void {
  const diagnostic = next.fleet?.lastError || next.error;
  if (diagnostic && diagnostic !== (snapshot.fleet?.lastError || snapshot.error)) {
    console.warn("[Herdr]", diagnostic);
  }
  snapshot = next;
  for (const listener of listeners) listener(next);
  // A page already holds task and CLI sync streams. Open the delivery stream
  // only while inputs are queued, so navigation/hydration keeps HTTP slots.
  const queued = next.fleet?.inputDeliveries?.some(input => input.status === "queued");
  if (listeners.size > 0 && queued && !events) {
    events = new EventSource("/api/herdr/events");
    events.onmessage = (event) => {
      try {
        const fleet = JSON.parse(event.data) as HerdrFleetResponse;
        eventVersion++;
        etag = null;
        publish({ ...snapshot, fleet, loading: false, error: null });
      } catch { /* polling recovers a malformed or interrupted event */ }
    };
  } else if (!queued || listeners.size === 0) {
    events?.close();
    events = null;
  }
}

async function poll(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const versionAtStart = eventVersion;
    try {
      const [fleetResponse, hooksResponse] = await Promise.all([
        fetch("/api/herdr/fleet", {
          cache: "no-store",
          headers: etag ? { "If-None-Match": etag } : undefined,
        }),
        fetch("/api/hooks/state", { cache: "no-store", headers: hooksEtag ? { "If-None-Match": hooksEtag } : undefined }),
      ]);
      if (!fleetResponse.ok && fleetResponse.status !== 304) {
        throw new Error(`Herdr fleet HTTP ${fleetResponse.status}`);
      }
      if (!hooksResponse.ok && hooksResponse.status !== 304) {
        throw new Error(`hook state HTTP ${hooksResponse.status}`);
      }
      const fleet =
        fleetResponse.status === 304 || eventVersion !== versionAtStart
          ? snapshot.fleet
          : ((await fleetResponse.json()) as HerdrFleetResponse);
      if (fleetResponse.status !== 304 && eventVersion === versionAtStart) {
        etag = fleetResponse.headers.get("etag");
      }
      // Refresh the projection on a 304 too: waiting-hook TTLs can expire
      // even when neither server-side record nor fleet ETag changed.
      const hooks = hooksResponse.status === 304 ? [...snapshot.hooks]
        : ((await hooksResponse.json()) as { records?: HerdrHookRecord[] }).records ?? [];
      if (hooksResponse.status !== 304) hooksEtag = hooksResponse.headers.get("etag");
      publish({
        fleet: eventVersion === versionAtStart ? fleet : snapshot.fleet,
        hooks,
        loading: false,
        error: null,
      });
    } catch (error) {
      publish({
        ...snapshot,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function subscribe(listener: (next: HerdrFleetSnapshot) => void): () => void {
  listeners.add(listener);
  listener(snapshot);
  if (listeners.size === 1) {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      events?.close();
      events = null;
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
