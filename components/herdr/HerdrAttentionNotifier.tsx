"use client";

import { useEffect, useRef } from "react";
import { Bell } from "lucide-react";
import { Button, Icon } from "@/components/ui";
import { openHerdrConsolePane, useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import {
  diffHerdrAttention,
  herdrAttentionText,
  type HerdrAttentionState,
} from "@/lib/herdr-console";
import { formatRelativeTime } from "@/lib/relative-time";
import { useSessionStore } from "@/stores/sessionStore";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

// 跨窗格通知：从 fleet / hook 镜像的状态变化派生（lib/herdr-console diffHerdrAttention）。
// 某窗格从非 blocked/waiting 变成 blocked/waiting、且你当前不在它的会话里 → 右下角通知卡，
// 切换条对应 chip 闪一下。同一窗格同一次卡住只通知一次；在 /herdr 总览时不弹（泳道本身就是）。
export function HerdrAttentionNotifier() {
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  const onOverview = useSessionStore((s) => !s.session && s.herdrOpen);
  const notice = useHerdrConsoleStore((s) => s.notice);
  const prev = useRef<HerdrAttentionState | null>(null);
  const context = useRef({ current: current?.key ?? null, onOverview });
  useEffect(() => {
    context.current = { current: current?.key ?? null, onOverview };
  });

  useEffect(() => {
    if (hc.loading || !hc.available) return;
    const { state, raised } = diffHerdrAttention(prev.current, hc.panes);
    prev.current = state;
    const store = useHerdrConsoleStore.getState();
    // 通知卡指向的窗格已经不再卡着（在别处处理掉了）→ 收起。
    if (store.notice && state.lanes.get(store.notice.key) !== "need") store.dismissNotice();
    const target = raised.filter((pane) => pane.key !== context.current.current).pop();
    if (!target || context.current.onOverview) return;
    store.raise({
      key: target.key,
      paneId: target.paneId,
      where: `${target.workspaceLabel} · ${target.tabLabel}`,
      text: herdrAttentionText(target),
      at: Date.now(),
    });
  }, [hc.panes, hc.loading, hc.available]);

  if (!notice || onOverview || notice.key === current?.key) return null;
  const go = () => {
    const pane = hc.panes.find((p) => p.key === notice.key);
    useHerdrConsoleStore.getState().dismissNotice();
    if (pane) openHerdrConsolePane(pane);
  };
  return (
    <div
      role="status"
      aria-live="polite"
      data-herdr-notice={notice.paneId}
      className="fixed bottom-4 z-40 w-[340px] max-w-[calc(100vw-2rem)] rounded-card border border-warn-line bg-surface-raised p-3 shadow-overlay max-md:inset-x-3 max-md:w-auto"
      style={{ right: "calc(var(--trellis-herdr-dw, 0px) + 1rem)" }}
    >
      <div className="flex items-center gap-2 text-ui">
        <Icon icon={Bell} size="sm" className="text-warn" />
        <b className="min-w-0 truncate font-semibold text-ink-strong">{notice.where}</b>
        <span className="ml-auto shrink-0 text-label text-ink-faint">需要你 · {formatRelativeTime(notice.at)}</span>
      </div>
      <p className="mb-2.5 mt-1.5 line-clamp-3 text-label text-ink-muted">{notice.text}</p>
      <div className="flex gap-1.5">
        <Button variant="primary" size="sm" onClick={go} data-herdr-notice-go>
          去处理
          <span className="font-mono text-nano opacity-80">⌥J</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => useHerdrConsoleStore.getState().dismissNotice()}>
          稍后
        </Button>
      </div>
    </div>
  );
}
