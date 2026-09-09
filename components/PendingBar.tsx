"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSessionStore } from "@/stores/sessionStore";
import { pendingKey, type PendingItem } from "@/lib/pending";
import { Button } from "./ui/Button";
import { openPendingItem } from "@/lib/pending-navigation";

export function PendingBar({ mobile = false, hiddenChrome = false }: { mobile?: boolean; hiddenChrome?: boolean }) {
  const snapshot = useSessionStore(s => s.pending);
  const submitting = useSessionStore(s => s.pendingSubmissions);
  const items = snapshot.items.filter(item => !submitting.has(item.nodeId));
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const rail = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (mobile) return;
    const update = () => document.documentElement.style.setProperty("--trellis-pending-h", `${rail.current?.getBoundingClientRect().height ?? 0}px`);
    update();
    const observer = new ResizeObserver(update);
    if (rail.current) observer.observe(rail.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--trellis-pending-h"); };
  }, [mobile, items.length, error]);
  useEffect(() => {
    if (mobile && expanded && items.length) dialog.current?.showModal();
    else dialog.current?.close();
  }, [mobile, expanded, items.length]);

  const close = () => { dialog.current?.close(); setExpanded(false); trigger.current?.focus(); };
  const jump = async (item: PendingItem) => {
    setError("");
    try {
      await openPendingItem(item, close, useSessionStore.getState(), nodeId => {
        const state = useSessionStore.getState();
        if (state.session?.id !== item.sessionId || state.activeNodeId !== nodeId) throw new Error("目标会话未能载入，请重试");
        useSessionStore.setState(s => ({ viewMode: "linear", pendingNavigation: {
          nodeId, sequence: (s.pendingNavigation?.sequence ?? 0) + 1,
        } }));
      });
    } catch (error) {
      console.error("[pending navigation]", error);
      setError(error instanceof Error ? error.message : "跳转失败，请重试。");
    }
  };
  const decide = async (item: PendingItem, allow: boolean) => {
    setError("");
    const result = await useSessionStore.getState().respondToInteraction(item.nodeId, item.interaction.toolUseId,
      allow ? { behavior: "allow", updatedInput: item.interaction.input } : { behavior: "deny", message: "用户拒绝了本次工具执行" });
    if (!result.ok && result.reason !== "stale") setError("处理失败，请重试。");
  };
  const list = <ul id={mobile ? "pending-mobile-list" : "pending-desktop-list"} className="max-h-[40vh] overflow-y-auto divide-y divide-warn-line/50">
    {items.map(item => <li key={pendingKey(item)} data-pending-item={pendingKey(item)} className="flex items-center gap-3 px-4 py-2 max-md:flex-wrap">
      <span className="shrink-0 rounded-field border border-warn-line px-1.5 py-0.5 text-nano text-warn-ink">{item.kind === "approval" ? "审批" : "提问"}</span>
      <span className="max-w-40 truncate text-ui font-medium" title={item.sessionTitle}>{item.sessionTitle}</span>
      <span className="min-w-0 flex-1 truncate text-ui text-ink-muted max-md:basis-full" title={item.summary}>{item.summary}</span>
      <time className="shrink-0 text-nano text-ink-faint" dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      <Button size="sm" variant="ghost" data-pending-jump onClick={() => void jump(item)}>去处理</Button>
      {item.kind === "approval" && <>
        <Button size="sm" variant="primary" data-pending-allow onClick={() => void decide(item, true)}>允许一次</Button>
        <Button size="sm" variant="secondary" data-pending-deny onClick={() => void decide(item, false)}>拒绝</Button>
      </>}
    </li>)}
  </ul>;
  if (!items.length) return null;
  return <div ref={rail} data-pending-bar={mobile ? "mobile" : "desktop"}
    className={mobile ? "relative z-20 shrink-0 bg-warn-muted transition-transform duration-200 motion-reduce:transition-none" : "fixed right-0 z-40 border-b border-warn-line bg-surface shadow-sm"}
    style={mobile ? { transform: hiddenChrome ? "translateY(calc(var(--safe-top) - var(--trellis-header-h) - 3.5rem))" : undefined } : { top: "var(--trellis-header-h)", left: "var(--trellis-sb, 0px)" }}>
    {(mobile || items.length > 1) && <button ref={trigger} type="button" data-mobile-waiting-banner={mobile ? "" : undefined}
      data-pending-toggle aria-expanded={expanded} aria-controls={mobile ? "pending-mobile-list" : "pending-desktop-list"}
      onClick={() => setExpanded(value => !value)} className={`flex min-h-11 w-full items-center justify-between gap-2 bg-warn-muted px-4 text-ui font-medium text-warn-ink ${mobile ? "border-b border-warn-line" : ""}`}>
      <span>有 {items.length} 项等你处理</span><span>{expanded ? "收起" : "查看待办"} <span aria-hidden>{expanded ? "↑" : "↓"}</span></span>
    </button>}
    {!mobile && (items.length === 1 || expanded) && list}
    {error && <p role="alert" className="px-4 py-2 text-ui text-danger">{error}</p>}
    {mobile && expanded && items.length > 0 && createPortal(<dialog ref={dialog} data-pending-sheet onCancel={close} onClose={close}
      onClick={e => { if (e.target === e.currentTarget) close(); }}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[75dvh] w-full max-w-none rounded-t-2xl border border-line bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim/50"
      style={{ paddingBottom: "var(--safe-bottom)" }} aria-label="待处理事项">
      <div className="flex items-center justify-between border-b border-line px-4 py-2"><h2 className="font-semibold">等你处理 · {items.length}</h2><Button variant="ghost" onClick={close}>关闭</Button></div>
      {list}
    </dialog>, document.body)}
  </div>;
}
