"use client";

import { useEffect, useRef, useState } from "react";
import type { HerdrPaneView } from "@/lib/herdr-ui";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";

export function HerdrSessionBadge({
  pane,
  loading,
}: {
  pane: HerdrPaneView | null;
  loading: boolean;
}) {
  return (
    <div
      data-herdr-badge
      className="flex min-w-0 items-center gap-1.5 text-label text-ink-faint"
      title={
        pane
          ? `${pane.workspaceLabel} · ${pane.paneId} · ${pane.agentKind} · ${pane.status}`
          : "Herdr 会话"
      }
    >
      <span className="shrink-0 rounded-full bg-accent-muted px-2 py-0.5 font-semibold text-accent-ink">
        ⚓ Herdr
      </span>
      {pane ? (
        <span className="min-w-0 truncate">
          {pane.workspaceLabel} · {pane.paneId} · {pane.agentKind} · {pane.status}
        </span>
      ) : (
        <span>{loading ? "正在读取 pane…" : "pane 已离线"}</span>
      )}
    </div>
  );
}

export function HerdrOfflineBanner({
  sessionId,
  pane,
  loading,
}: {
  sessionId: string;
  pane: HerdrPaneView | null;
  loading: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );
  if (loading || pane?.alive) return null;

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

  return (
    <div
      data-herdr-readonly
      className="flex flex-col gap-3 rounded-card border border-warn-line bg-warn-muted px-4 py-3 text-sm text-warn-ink sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold">此 Herdr pane 已离线，会话现为只读</div>
        <div className="mt-0.5 text-label opacity-80">
          历史 transcript 仍可阅读；Trellis 不会接管这个 agent runtime。
        </div>
      </div>
      <button
        type="button"
        data-mobile-target="herdr-reopen"
        data-herdr-reopen
        onClick={reopen}
        disabled={state === "busy" || state === "done"}
        className="min-h-11 shrink-0 rounded-field border border-warn-line bg-surface px-4 text-sm font-medium disabled:opacity-60"
      >
        {state === "busy"
          ? "正在重新打开…"
          : state === "done"
            ? "已在 Herdr 打开"
            : state === "error"
              ? "重试在 Herdr 里打开"
              : "在 Herdr 里重新打开"}
      </button>
    </div>
  );
}

export function HerdrComposer({ pane }: { pane: HerdrPaneView }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<
    "idle" | "sending" | "delivered" | "error"
  >("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const submit = async () => {
    const outgoing = text.trim();
    if (!outgoing || state === "sending") return;
    setState("sending");
    try {
      const response = await fetch(
        `/api/herdr/panes/${encodeURIComponent(pane.paneId)}/input`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: outgoing }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setText("");
      setState("delivered");
      void refreshHerdrFleet();
      timerRef.current = setTimeout(() => setState("idle"), 2_400);
    } catch {
      setState("error");
    }
  };

  return (
    <div data-herdr-composer className="py-2 max-md:py-1.5">
      <div className="mb-1 flex min-h-4 items-center justify-between gap-2 text-label">
        <span className="text-ink-faint">
          {pane.status === "working"
            ? "Agent 正在工作；这条消息会在 Herdr 中排队"
            : "直接送到 Herdr pane"}
        </span>
        <span
          data-herdr-delivery={state}
          aria-live="polite"
          className={state === "error" ? "text-danger" : "text-positive"}
        >
          {state === "delivered"
            ? "已送达 Herdr"
            : state === "error"
              ? "发送失败，请重试"
              : ""}
        </span>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          data-herdr-input
          data-mobile-target="herdr-input"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (state === "error") setState("idle");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
          disabled={state === "sending"}
          placeholder="发给 Herdr…（Enter 发送，Shift+Enter 换行）"
          className="min-h-11 max-h-32 min-w-0 flex-1 touch-manipulation resize-none rounded-2xl border border-line-strong bg-surface px-4 py-3 text-body text-ink-strong outline-none placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent-line/50 disabled:opacity-60"
        />
        <button
          type="button"
          data-mobile-target="herdr-send"
          data-herdr-send
          onClick={() => void submit()}
          disabled={!text.trim() || state === "sending"}
          className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-2xl bg-accent text-ink-inverse shadow-raise disabled:opacity-30"
          aria-label={state === "sending" ? "正在发送到 Herdr" : "发送到 Herdr"}
        >
          {state === "sending" ? "…" : "↑"}
        </button>
      </div>
    </div>
  );
}
