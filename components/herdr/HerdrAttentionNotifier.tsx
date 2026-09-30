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
import { useIsMobile } from "@/hooks/useIsMobile";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

// 跨窗格通知：从 fleet / hook 镜像的状态变化派生（lib/herdr-console diffHerdrAttention）。
// 某窗格从非 blocked/waiting 变成 blocked/waiting、且你当前不在它的会话里 → 右下角通知卡，
// 切换条对应 chip 闪一下。同一窗格同一次卡住只通知一次；在 /herdr 总览时不弹（泳道本身就是）。
export function HerdrAttentionNotifier() {
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  const onOverview = useSessionStore((s) => !s.session && s.herdrOpen);
  const notice = useHerdrConsoleStore((s) => s.notice);
  const isMobile = useIsMobile();
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
    // 会话区右上角、窗格切换条正下方（切换条上的 chip 同时在闪，空间相邻）。右下角已被
    // 输入框、会话树浮窗、终端把手占满，不再在底部避让：top = 标签条下沿 + 待办条
    // + 切换条（--trellis-herdr-strip-h，非 Herdr 会话为 0）+ 8px；右边距只让终端抽屉。
    // 从上方滑入（@starting-style）。
    <div
      role="status"
      aria-live="polite"
      data-herdr-notice={notice.paneId}
      className="fixed z-50 w-[320px] max-w-[calc(100vw-2rem)] rounded-card border border-warn-line bg-surface-raised p-3 shadow-overlay transition-[opacity,translate] duration-200 ease-out starting:-translate-y-2 starting:opacity-0 motion-reduce:transition-none max-md:inset-x-3 max-md:w-auto"
      style={{
        top: isMobile
          ? "calc(var(--trellis-header-h) + 0.5rem)"
          : "calc(5.25rem + var(--trellis-pending-h, 0px) + var(--trellis-herdr-strip-h, 0px) + 0.5rem)",
        right: isMobile ? undefined : "calc(var(--trellis-rp, 0px) + var(--trellis-herdr-dw, 0px) + 1rem)",
      }}
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
