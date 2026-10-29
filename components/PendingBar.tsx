"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pendingKey, type PendingItem } from "@/lib/pending";
import { allowLabel, approvalToolKey, describeToolKey, type ApprovalScope } from "@/lib/approval-rules";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button, Icon } from "@/components/ui";
import { usePendingActions } from "@/hooks/usePendingActions";

export function PendingBar({ mobile = false, hiddenChrome = false }: { mobile?: boolean; hiddenChrome?: boolean }) {
  const { items, error, jump, decide } = usePendingActions();
  const [expanded, setExpanded] = useState(false);
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
  const list = <ul id={mobile ? "pending-mobile-list" : "pending-desktop-list"} className="max-h-[40vh] overflow-y-auto divide-y divide-warn-line/50">
    {items.map(item => <PendingRow key={pendingKey(item)} item={item} jump={() => void jump(item, close)} decide={decide} />)}
  </ul>;
  if (!items.length) return null;
  return <div ref={rail} data-pending-bar={mobile ? "mobile" : "desktop"}
    className={mobile ? "relative z-20 shrink-0 bg-warn-muted transition-transform duration-200 motion-reduce:transition-none" : "fixed right-0 z-40 border-b border-warn-line bg-surface"}
    style={mobile ? { transform: hiddenChrome ? "translateY(calc(var(--safe-top) - var(--trellis-header-h) - 3.5rem))" : undefined } : { top: "var(--trellis-header-h)", left: "var(--trellis-sb, 0px)" }}>
    {(mobile || items.length > 1) && <button ref={trigger} type="button" data-mobile-waiting-banner={mobile ? "" : undefined}
      data-pending-toggle aria-expanded={expanded} aria-controls={mobile ? "pending-mobile-list" : "pending-desktop-list"}
      onClick={() => setExpanded(value => !value)} className={`flex min-h-11 w-full items-center justify-between gap-2 bg-warn-muted px-4 text-ui font-medium text-warn-ink ${mobile ? "border-b border-warn-line" : ""}`}>
      <span>有 {items.length} 项等你处理</span><span className="inline-flex items-center gap-1">{expanded ? "收起" : "查看待办"}<Icon icon={expanded ? ChevronUp : ChevronDown} size="sm" /></span>
    </button>}
    {!mobile && (items.length === 1 || expanded) && list}
    {error && <p role="alert" className="px-4 py-2 text-ui text-danger-ink">{error}</p>}
    {mobile && expanded && items.length > 0 && createPortal(<dialog ref={dialog} data-pending-sheet onCancel={close} onClose={close}
      onClick={e => { if (e.target === e.currentTarget) close(); }}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[75dvh] w-full max-w-none rounded-t-2xl border border-line bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim/50"
      style={{ paddingBottom: "var(--safe-bottom)" }} aria-label="待处理事项">
      <div className="flex items-center justify-between border-b border-line px-4 py-2"><h2 className="font-semibold">等你处理 · {items.length}</h2><Button variant="ghost" onClick={close}>关闭</Button></div>
      {list}
    </dialog>, document.body)}
  </div>;
}

// 一条待办。审批项：主按钮「允许一次」+ 拒绝 + 「始终允许…」，后者原地展开出
// 本会话 / 所有会话两档和将放行的规则文本（与审批卡同一套三档作用域）。原地展开
// 而不是下拉菜单：手机端这一层在 showModal 的 <dialog> 里，portal 出去的菜单会落在
// top layer 之下点不到。
function PendingRow({ item, jump, decide }: {
  item: PendingItem;
  jump: () => void;
  decide: (item: PendingItem, allow: boolean, scope?: ApprovalScope) => Promise<void>;
}) {
  const [more, setMore] = useState(false);
  const toolKey = item.kind === "approval" ? approvalToolKey(item.interaction) : null;
  const moreId = `pending-more-${pendingKey(item)}`;
  return <li data-pending-item={pendingKey(item)} className="px-4 py-2">
    <div className="flex items-center gap-3 max-md:flex-wrap">
      <span className="shrink-0 rounded-field border border-warn-line px-1.5 py-0.5 text-nano text-warn-ink">{item.kind === "approval" ? "审批" : "提问"}</span>
      <span className="max-w-40 truncate text-ui font-medium" title={item.sessionTitle}>{item.sessionTitle}</span>
      <span className="min-w-0 flex-1 truncate text-ui text-ink-muted max-md:basis-full" title={item.summary}>{item.summary}</span>
      <time className="shrink-0 text-nano text-ink-faint" dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
      <Button size="sm" variant="ghost" data-pending-jump onClick={jump}>去处理</Button>
      {item.kind === "approval" && <>
        <Button size="sm" variant="primary" data-pending-allow onClick={() => void decide(item, true)}>允许一次</Button>
        <Button size="sm" variant="secondary" data-pending-deny onClick={() => void decide(item, false)}>拒绝</Button>
        {toolKey && <Button size="sm" variant="ghost" data-pending-more aria-expanded={more} aria-controls={moreId}
          onClick={() => setMore(v => !v)} className="font-normal">始终允许…</Button>}
      </>}
    </div>
    {more && toolKey && <div id={moreId} data-pending-scopes className="mt-2 flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
      <span className="min-w-0 flex-1 text-label text-ink-muted">将放行 {describeToolKey(toolKey)}</span>
      {(["session", "global"] as const).map(scope => <Button key={scope} size="sm" variant="secondary" data-pending-scope={scope}
        onClick={() => void decide(item, true, scope)} className={scope === "global" ? "text-warn-ink" : undefined}>{allowLabel(scope)}</Button>)}
    </div>}
  </li>;
}
