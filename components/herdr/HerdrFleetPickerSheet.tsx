"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Flame,
  Plus,
  Snowflake,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  Button,
  Icon,
  IconButton,
  Spinner,
  StatusDot,
  cn,
  toast,
} from "@/components/ui";
import {
  openHerdrConsolePane,
  useCurrentHerdrPane,
  useHerdrConsole,
} from "@/hooks/useHerdrConsole";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import { createHerdrTab } from "@/lib/herdr-actions";
import { HERDR_LANE_LABEL, type HerdrConsolePane } from "@/lib/herdr-console";
import { herdrGroupName } from "@/lib/herdr-mode";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

export function HerdrFleetPickerSheet() {
  const open = useHerdrConsoleStore((s) => s.fleetPickerOpen);
  const close = () => useHerdrConsoleStore.getState().setFleetPickerOpen(false);
  const hc = useHerdrConsole();
  const current = useCurrentHerdrPane(hc.panes);
  const [creating, setCreating] = useState(false);
  const [showCold, setShowCold] = useState(false);

  // 冷热分流：
  // Hot = 阻塞需要人 (need)、正在运行 (run)、或当前所选
  // Cold = 空闲就绪 (idle)、纯 shell / 离线 (off)
  const { hotPanes, coldPanes } = useMemo(() => {
    const hot: HerdrConsolePane[] = [];
    const cold: HerdrConsolePane[] = [];
    for (const p of hc.panes) {
      const isCurrent = current?.key === p.key;
      if (p.lane === "need" || p.lane === "run" || isCurrent) {
        hot.push(p);
      } else {
        cold.push(p);
      }
    }
    // 排序：need > run > current
    hot.sort((a, b) => {
      if (a.lane === "need" && b.lane !== "need") return -1;
      if (b.lane === "need" && a.lane !== "need") return 1;
      if (a.lane === "run" && b.lane !== "run") return -1;
      if (b.lane === "run" && a.lane !== "run") return 1;
      return (b.activityAt ?? 0) - (a.activityAt ?? 0);
    });

    // 挂起/冷窗格：严格按最近活跃时间倒序排
    cold.sort((a, b) => (b.activityAt ?? 0) - (a.activityAt ?? 0));

    return { hotPanes: hot, coldPanes: cold };
  }, [hc.panes, current?.key]);

  if (!open) return null;

  const handleSelect = (pane: HerdrConsolePane) => {
    close();
    openHerdrConsolePane(pane);
  };

  const handleOpenTerminal = (e: React.MouseEvent, paneId: string) => {
    e.stopPropagation();
    close();
    useHerdrConsoleStore.getState().openDrawer(paneId);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await createHerdrTab({
        workspaceId: current?.workspaceId,
        cwd: current?.cwd ?? undefined,
      });
      toast.success("已创建新终端 Tab");
      close();
      refreshHerdrFleet();
      if (res.paneId) {
        useHerdrConsoleStore.getState().openDrawer(res.paneId);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* 磨砂遮罩 */}
      <div
        aria-hidden
        className="fixed inset-0 bg-scrim/60 backdrop-blur-xs ui-enter-fade"
        onClick={close}
      />

      {/* 底部拉出 Sheet */}
      <section
        data-herdr-fleet-picker
        role="dialog"
        aria-modal="true"
        aria-label="并行会话切换"
        className="relative z-10 flex max-h-[82vh] flex-col rounded-t-overlay border-t border-line-strong bg-surface-raised shadow-overlay ui-enter-slide-up"
        style={{ paddingBottom: "max(var(--safe-bottom, 0px), 12px)" }}
      >
        {/* 顶部指示条与标题 */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink-strong">并行会话切换</span>
            <span className="rounded-field bg-surface-muted px-1.5 py-0.5 font-mono text-nano text-ink-faint">
              {hc.panes.length} 个窗格
            </span>
          </div>
          <IconButton label="关闭" size="sm" onClick={close}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>

        {/* 列表滚动区 */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {/* 🔥 活跃并行 */}
          <div className="mb-1 flex items-center gap-1.5 px-2 py-1 text-label font-medium text-ink-faint">
            <Icon icon={Flame} size="sm" className="text-warn" />
            <span>活跃并行 ({hotPanes.length})</span>
          </div>

          <div className="flex flex-col gap-1.5">
            {hotPanes.map((pane) => {
              const isCurrent = current?.key === pane.key;
              const isNeed = pane.lane === "need";
              const isRun = pane.lane === "run";

              return (
                <button
                  key={pane.key}
                  type="button"
                  onClick={() => handleSelect(pane)}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-card border px-3 py-2.5 text-left transition-colors",
                    isCurrent
                      ? "border-accent-line bg-accent-muted/40 text-accent-ink"
                      : isNeed
                        ? "border-warn-line bg-warn-muted/20 text-ink-strong"
                        : "border-line bg-surface text-ink hover:border-line-strong",
                  )}
                >
                  <div className="flex shrink-0 items-center justify-center">
                    {isNeed ? (
                      <StatusDot tone="warn" className="ring-3 ring-warn-muted" />
                    ) : isRun ? (
                      <Spinner size="sm" label={null} />
                    ) : (
                      <StatusDot tone="idle" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 font-medium leading-tight">
                      <span className="truncate text-ui">{pane.title}</span>
                      {isCurrent && (
                        <span className="rounded-field bg-accent/20 px-1 font-mono text-nano text-accent-ink">
                          当前
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-label text-ink-muted">
                      <span>{pane.workspaceLabel}</span>
                      <span>·</span>
                      <span>{pane.tabLabel}</span>
                      {pane.activityAt && (
                        <>
                          <span>·</span>
                          <span className="font-mono text-nano text-ink-faint">
                            {formatRelativeTimeShort(pane.activityAt)}
                          </span>
                        </>
                      )}
                      {isNeed && (
                        <>
                          <span>·</span>
                          <span className="font-semibold text-warn">⚠️ 阻断审批</span>
                        </>
                      )}
                      {isRun && (
                        <>
                          <span>·</span>
                          <span className="text-accent">运行中</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-label text-ink-faint">
                      {HERDR_LANE_LABEL[pane.lane]}
                    </span>
                    <IconButton
                      label="打开此窗格终端"
                      size="sm"
                      onClick={(e) => handleOpenTerminal(e, pane.paneId)}
                    >
                      <Icon icon={SquareTerminal} size="sm" />
                    </IconButton>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ❄️ 闲置 / 纯 Shell */}
          {coldPanes.length > 0 && (
            <div className="mt-4 border-t border-line-faint pt-2">
              <button
                type="button"
                onClick={() => setShowCold(!showCold)}
                className="flex w-full items-center justify-between px-2 py-1.5 text-label font-medium text-ink-faint"
              >
                <div className="flex items-center gap-1.5">
                  <Icon icon={Snowflake} size="sm" className="text-ink-muted" />
                  <span>按活跃时间排序的挂起窗格 ({coldPanes.length})</span>
                </div>
                <Icon
                  icon={showCold ? ChevronDown : ChevronRight}
                  size="sm"
                  className="text-ink-faint"
                />
              </button>

              {showCold && (
                <div className="mt-1 flex flex-col gap-1">
                  {coldPanes.map((pane) => (
                    <div
                      key={pane.key}
                      onClick={() => handleSelect(pane)}
                      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-field px-3 py-2 text-left text-label text-ink-muted transition-colors hover:bg-surface-hover"
                    >
                      <Icon icon={SquareTerminal} size="sm" className="shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate font-mono text-ink">{pane.title}</span>
                      <span className="text-nano text-ink-faint">{pane.workspaceLabel}</span>
                      {pane.activityAt && (
                        <span className="font-mono text-nano text-ink-faint">
                          {formatRelativeTimeShort(pane.activityAt)}
                        </span>
                      )}
                      <IconButton
                        label="打开此窗格终端"
                        size="sm"
                        onClick={(e) => handleOpenTerminal(e, pane.paneId)}
                      >
                        <Icon icon={SquareTerminal} size="sm" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部快捷操作条 */}
        <div className="shrink-0 border-t border-line p-3">
          <Button
            variant="secondary"
            className="w-full justify-center gap-2 font-medium"
            disabled={creating}
            onClick={handleCreate}
          >
            {creating ? <Spinner size="sm" label={null} /> : <Icon icon={Plus} size="sm" />}
            <span>新建终端 Tab (Shell)</span>
          </Button>
        </div>
      </section>
    </div>
  );
}
