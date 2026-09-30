"use client";

import { useState } from "react";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";

export type HerdrReopenState = "idle" | "busy" | "done" | "error";

/** 「在 Herdr 里重新打开」：离线横幅与 Herdr 输入框的离线态共用。 */
export function useHerdrReopen(sessionId: string) {
  const [state, setState] = useState<HerdrReopenState>("idle");
  const reopen = async () => {
    if (state === "busy") return;
    setState("busy");
    try {
      const response = await fetch(
        `/api/herdr/sessions/${encodeURIComponent(sessionId)}/reopen`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState("done");
      await refreshHerdrFleet();
    } catch {
      setState("error");
    }
  };
  const label =
    state === "busy"
      ? "正在重新打开…"
      : state === "done"
        ? "已在 Herdr 打开"
        : state === "error"
          ? "重试在 Herdr 里打开"
          : "在 Herdr 里重新打开";
  return { state, reopen, label };
}
