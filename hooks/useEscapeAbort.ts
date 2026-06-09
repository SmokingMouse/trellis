"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

// Global Esc → abort the in-flight stream, with anti-misfire.
//
// A single Esc no longer kills a long-running task. The first press *arms* a
// confirm prompt (store.abortArm → AbortToast shows "再按 Esc 中止"); a second
// Esc on the same target within ARM_MS actually stops it. A stray single press
// just flashes the prompt and auto-disarms after ARM_MS. The ⏹ stop button
// stays a deliberate one-click abort — there's no misfire risk in a click.
//
// abortStream() (whichever path) sets store.abortRecovery, so a stop is always
// followed by a one-click "重新运行" toast (recovery).
//
// Esc inside textareas / inputs is left alone — those have local semantics
// (close popovers, the Zone editor, etc.).
const ARM_MS = 3000;

export function useEscapeAbort() {
  useEffect(() => {
    let armedNode: string | null = null;
    let armedAt = 0;
    let armTimer: number | undefined;

    const disarm = () => {
      armedNode = null;
      if (armTimer) {
        window.clearTimeout(armTimer);
        armTimer = undefined;
      }
      useSessionStore.getState().setAbortArm(null);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const store = useSessionStore.getState();
      const active = store.activeNodeId;
      const activeNode = active ? store.nodes[active] : null;
      const target =
        activeNode?.status === "streaming"
          ? active
          : store.latestStreamingNodeId();
      // Nothing streaming → let other Esc handlers (overlays etc.) run.
      if (!target) return;

      e.preventDefault();

      if (armedNode === target && Date.now() - armedAt < ARM_MS) {
        // Second press on the same target → confirm the stop.
        // abortStream() sets the recovery toast.
        disarm();
        store.abortStream(target);
        return;
      }

      // First press → arm the confirm prompt; do NOT stop yet.
      const node = store.nodes[target];
      const label = node ? node.topicLabel ?? node.question.slice(0, 40) : "";
      armedNode = target;
      armedAt = Date.now();
      store.setAbortArm({ nodeId: target, label });
      if (armTimer) window.clearTimeout(armTimer);
      armTimer = window.setTimeout(disarm, ARM_MS);
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (armTimer) window.clearTimeout(armTimer);
    };
  }, []);
}
