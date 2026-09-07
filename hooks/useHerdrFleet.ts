"use client";

import { useEffect, useState } from "react";
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
const listeners = new Set<(next: HerdrFleetSnapshot) => void>();

function publish(next: HerdrFleetSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener(next);
}

async function poll(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
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
        fleetResponse.status === 304
          ? snapshot.fleet
          : ((await fleetResponse.json()) as HerdrFleetResponse);
      if (fleetResponse.status !== 304) {
        etag = fleetResponse.headers.get("etag");
      }
      // Refresh the projection on a 304 too: waiting-hook TTLs can expire
      // even when neither server-side record nor fleet ETag changed.
      const hooks = hooksResponse.status === 304 ? [...snapshot.hooks]
        : ((await hooksResponse.json()) as { records?: HerdrHookRecord[] }).records ?? [];
      if (hooksResponse.status !== 304) hooksEtag = hooksResponse.headers.get("etag");
      publish({
        fleet,
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
