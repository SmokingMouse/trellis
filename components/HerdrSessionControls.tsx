"use client";

import { useEffect, useRef, useState } from "react";
import type { HerdrPaneView } from "@/lib/herdr-ui";
import { refreshHerdrFleet, useHerdrFleet } from "@/hooks/useHerdrFleet";
import type { HerdrInputDelivery } from "@/lib/herdr-input";
import { Anchor, ArrowUp } from "lucide-react";
import { Icon, Spinner } from "@/components/ui";

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
          ? `${pane.workspaceLabel} · 窗格 ${pane.paneId} · ${pane.agentKind} · ${pane.alive ? pane.status : "已离线"}`
          : "Herdr 会话"
      }
    >
      <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 font-medium text-ink-muted">
        <Icon icon={Anchor} size="sm" />
        Herdr
      </span>
      {pane ? (
        <span className="min-w-0 truncate">
          {pane.workspaceLabel} · {pane.paneId} · {pane.agentKind} · {pane.alive ? pane.status : "已离线"}
        </span>
      ) : (
        <span>{loading ? "正在读取窗格…" : "窗格已离线"}</span>
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
        <div className="font-semibold">这个 Herdr 窗格已离线，会话现为只读</div>
        <div className="mt-0.5 text-label opacity-80">
          历史记录仍可阅读；Trellis 不会接管这个 agent 进程。
        </div>
      </div>
      <button
        type="button"
        data-mobile-target="herdr-reopen"
        data-herdr-reopen
        onClick={reopen}
        disabled={state === "busy" || state === "done"}
        className="min-h-8 shrink-0 rounded-field border border-warn-line bg-surface px-3 text-ui font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60 max-md:min-h-11"
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
  const { fleet } = useHerdrFleet();
  const [inputId, setInputId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<
    "idle" | "sending" | "queued" | "delivered" | "error"
  >("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(new Map<string, string>());

  useEffect(() => {
    let failed = false;
    for (const delivery of fleet?.inputDeliveries ?? []) {
      const outgoing = pendingRef.current.get(delivery.inputId);
      if (outgoing === undefined || delivery.paneId !== pane.paneId || delivery.status === "queued") continue;
      pendingRef.current.delete(delivery.inputId);
      if (delivery.status === "delivered") {
        // A receipt must not erase a newer draft or another failed input.
        setText(current => current === outgoing ? "" : current);
        if (delivery.inputId === inputId) setState("delivered");
      } else {
        setText(current => !current || current === outgoing ? outgoing : `${current}\n${outgoing}`);
        failed = true;
      }
    }
    if (failed) setState("error");
  }, [fleet?.inputDeliveries, inputId, pane.paneId]);
  useEffect(() => {
    setInputId(null);
    pendingRef.current.clear();
    setState("idle");
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [pane.paneId]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const submit = async () => {
    const draft = text;
    const outgoing = text.trim();
    if (!outgoing || state === "sending") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setInputId(null);
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
      const { result } = await response.json() as { result: HerdrInputDelivery };
      if (result.status === "queued") pendingRef.current.set(result.inputId, draft);
      else setText(current => current === draft ? "" : current);
      setInputId(result.inputId);
      setState(result.status === "queued" ? "queued" : "delivered");
      void refreshHerdrFleet();
      if (result.status === "delivered") timerRef.current = setTimeout(() => setState("idle"), 2_400);
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
            : "直接发给 Herdr 窗格"}
        </span>
        <span
          data-herdr-delivery={state}
          aria-live="polite"
          className={state === "error" ? "text-danger-ink" : "text-ink-muted"}
        >
          {state === "delivered"
            ? "已送达 Herdr"
            : state === "queued"
              ? "已排队，空闲后自动发送"
            : state === "error"
              ? "发送失败，请重试"
              : ""}
        </span>
      </div>
      {/* 外观与主输入框（Composer）一致：一个描边框，输入区无框，发送键收在右下角。 */}
      <div className="flex items-end gap-2 rounded-card border border-line bg-surface p-1.5 pl-3 transition-colors focus-within:border-accent-line focus-within:ring-2 focus-within:ring-focus-ring">
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
          aria-label="发给 Herdr 的消息"
          className="min-h-8 max-h-32 min-w-0 flex-1 touch-manipulation resize-none self-center bg-transparent py-1.5 text-body text-ink-strong outline-none placeholder:text-ink-faint disabled:opacity-60 max-md:min-h-11"
        />
        <button
          type="button"
          data-mobile-target="herdr-send"
          data-herdr-send
          onClick={() => void submit()}
          disabled={!text.trim() || state === "sending"}
          className="flex size-8 shrink-0 touch-manipulation items-center justify-center rounded-field bg-accent text-accent-fg transition-colors hover:bg-accent-strong disabled:opacity-35 max-md:size-11"
          aria-label={state === "sending" ? "正在发送到 Herdr" : "发送到 Herdr"}
        >
          {state === "sending" ? <Spinner size="sm" label={null} /> : <Icon icon={ArrowUp} />}
        </button>
      </div>
    </div>
  );
}
