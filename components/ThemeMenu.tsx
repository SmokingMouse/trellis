"use client";
import { useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { PALETTES } from "@/lib/themes";
import type { ThemeMode } from "@/lib/themes";
import { Check, Moon, Sun } from "lucide-react";
import { Icon, IconButton, Popover, SegmentedControl } from "@/components/ui";

// Header 的主题入口：亮/暗/跟随系统 三段 + 主题皮肤 swatch 列表。
// 面板内点选不关闭——方便连续试肤；outside-click / Esc 关闭（Popover 内置）。

const MODE_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "系统" },
];

export function ThemeMenu() {
  const { mode, resolvedDark, palette, setMode, setPalette } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      panelClassName="w-52 text-sm"
      trigger={
        <IconButton
          label="主题"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {mode === null ? (
            <span className="block size-4" aria-hidden />
          ) : (
            <Icon icon={resolvedDark ? Moon : Sun} />
          )}
        </IconButton>
      }
    >
      <div className="px-3 pt-2.5 pb-1 text-nano uppercase tracking-wide text-ink-faint">
        外观
      </div>
      <div className="px-2 pb-2">
        <SegmentedControl<ThemeMode>
          aria-label="外观"
          size="sm"
          fullWidth
          value={mode ?? "system"}
          onValueChange={setMode}
          options={MODE_OPTIONS}
        />
      </div>
      <div className="px-3 pt-1.5 pb-1 text-nano uppercase tracking-wide text-ink-faint border-t border-line-faint">
        主题
      </div>
      <div className="pb-1.5">
        {PALETTES.map((p) => (
          <button
            key={p.id}
            onClick={() => setPalette(p.id)}
            aria-pressed={palette === p.id}
            className={`w-full text-left px-3 min-h-8 flex items-center gap-2.5 transition-colors ${
              palette === p.id ? "bg-surface-hover" : "hover:bg-surface-hover"
            }`}
          >
            <span className="flex shrink-0 rounded-full overflow-hidden border border-line w-[30px] h-[14px]">
              {p.preview.map((c, i) => (
                <span key={i} className="flex-1" style={{ background: c }} />
              ))}
            </span>
            <span className="text-ui text-ink flex-1">{p.label}</span>
            {palette === p.id && (
              <Icon icon={Check} size="sm" className="text-accent-ink" />
            )}
          </button>
        ))}
      </div>
    </Popover>
  );
}
