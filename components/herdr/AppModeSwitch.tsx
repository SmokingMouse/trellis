"use client";

import { Anchor, MessagesSquare } from "lucide-react";
import { SegmentedControl, StatusDot } from "@/components/ui";
import { switchAppMode, useAppMode } from "@/hooks/useAppMode";
import { useHerdrConsole } from "@/hooks/useHerdrConsole";
import { herdrLaneCounts } from "@/lib/herdr-console";
import type { AppMode } from "@/lib/herdr-mode";

// 侧栏顶部的模式切换：[对话 | Herdr]。Herdr 侧带「需要你」计数（warn 点）。
// 取代原来置顶区上方那行「Herdr」入口。模式是当前视图的投影（hooks/useAppMode）：
// 切到 Herdr = 打开总览；切回对话 = 回到上次的普通会话（没有就首页）。
export function AppModeSwitch() {
  const mode = useAppMode();
  const { panes, available } = useHerdrConsole();
  const need = available ? herdrLaneCounts(panes).need : 0;
  return (
    <SegmentedControl<AppMode>
      aria-label="模式"
      fullWidth
      value={mode}
      onValueChange={(next) => {
        if (next !== mode) switchAppMode(next);
      }}
      options={[
        { value: "chat", icon: MessagesSquare, label: "对话" },
        {
          value: "herdr",
          icon: Anchor,
          label: (
            <span className="inline-flex items-center gap-1.5" data-app-mode-herdr>
              Herdr
              {need > 0 && (
                <span className="inline-flex items-center gap-1 text-label font-medium text-warn-ink" data-herdr-need-count title={`${need} 个窗格需要你`}>
                  <StatusDot tone="warn" className="ring-3 ring-warn-muted" label={`${need} 个需要你`} />
                  {need}
                </span>
              )}
            </span>
          ),
        },
      ]}
    />
  );
}
