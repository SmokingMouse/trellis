"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

/** DB revisions also cover turns created by another client while no node is open. */
export function useAsAdoption() {
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let versions = new Map<string,number>();
    async function poll() {
      let enabled = true;
      try {
        const response = await fetch("/api/as/adoption",{signal:controller.signal});
        if (!response.ok) return;
        const data = await response.json();
        enabled = data.enabled;
        if (!enabled) return;
        const next = new Map<string,number>((data.sessions ?? []).map((s:{id:string;revision:number}) => [s.id,s.revision]));
        const store = useSessionStore.getState();
        if (next.size !== versions.size || [...next].some(([id,v]) => versions.get(id) !== v)) store.bumpSessionsRevision();
        const active = store.session?.id;
        // Initial discovery must not reload hydrate's previous session while a
        // deep link is loading a different one. That load already reads the DB.
        if (active && versions.has(active) && next.has(active) && next.get(active) !== versions.get(active)) await store.loadSession(active);
        versions = next;
      } catch { /* Keep previous revisions for reconnect. */ }
      finally { if (!controller.signal.aborted && enabled) timer = setTimeout(() => void poll(),1500); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  },[]);
}
