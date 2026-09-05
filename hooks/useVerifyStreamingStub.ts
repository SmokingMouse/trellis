"use client";

import { useEffect } from "react";
import type { ChatNode } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";

const VERIFY_STREAMING_EVENT = "trellis:mobile-verify-streaming";
const VERIFY_STREAMING_NONCE = "trellis-mobile-verify-streaming";

export function useVerifyStreamingStub(
  isMobile: boolean,
  sessionId: string | undefined,
) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_TRELLIS_VERIFY !== "1") return;
    if (!isMobile || typeof window === "undefined") return;
    if (
      window.location.hostname !== "127.0.0.1" &&
      window.location.hostname !== "localhost"
    ) {
      return;
    }

    let injectedId: string | null = null;
    let previousStatus: ChatNode["status"] | null = null;

    const restore = () => {
      if (!injectedId || !previousStatus) return;
      useSessionStore.setState((state) => {
        const node = state.nodes[injectedId!];
        if (!node || node.status !== "streaming") return state;
        return {
          nodes: {
            ...state.nodes,
            [injectedId!]: { ...node, status: previousStatus! },
          },
        };
      });
      injectedId = null;
      previousStatus = null;
    };

    const inject = (event: Event) => {
      const requestedId = (event as CustomEvent<unknown>).detail;
      if (requestedId === null) {
        restore();
        return;
      }
      if (
        typeof requestedId !== "string" ||
        window.sessionStorage.getItem(VERIFY_STREAMING_NONCE) !== requestedId
      ) {
        return;
      }
      restore();
      useSessionStore.setState((state) => {
        const node = state.nodes[requestedId];
        if (!node || node.sessionId !== state.session?.id) return state;
        injectedId = requestedId;
        previousStatus = node.status;
        return {
          nodes: {
            ...state.nodes,
            [requestedId]: { ...node, status: "streaming" },
          },
        };
      });
    };

    window.addEventListener(VERIFY_STREAMING_EVENT, inject);
    return () => {
      window.removeEventListener(VERIFY_STREAMING_EVENT, inject);
      restore();
    };
  }, [isMobile, sessionId]);
}
