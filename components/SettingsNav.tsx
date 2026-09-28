"use client";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import {
  Bot,
  CalendarClock,
  CircleArrowUp,
  Cpu,
  MessagesSquare,
  Server,
  Share2,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { Icon, cn } from "@/components/ui";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_GROUPS,
  type SettingsTabIconKey,
} from "@/lib/settings-tabs";

// settings-tabs.ts 只存 key（它被 next.config.ts 引用，不拖 React 进配置加载）；
// Record 保证新增 key 漏配时编译失败。
const TAB_ICONS: Record<SettingsTabIconKey, LucideIcon> = {
  bot: Bot,
  "calendar-clock": CalendarClock,
  cpu: Cpu,
  "messages-square": MessagesSquare,
  share: Share2,
  "square-terminal": SquareTerminal,
  server: Server,
  sliders: SlidersHorizontal,
  "circle-arrow-up": CircleArrowUp,
};

// S89: 管理台的 tab 导航。
//
// 两件事值得写下来：
// ① 用 useSelectedLayoutSegment 而不是 usePathname —— 它直接返回 layout 下一级的段
//    （agents / tasks / update），不用做字符串前缀匹配，也就不会在将来出现
//    /settings/agents/[id] 这种子路由时把高亮判错。
// ② tab 之间用 <Link>（客户端跳转，layout 不重渲染）。这与「主 SPA ↔ 管理台之间用 <a>
//    硬导航」不矛盾：那条规矩是为了跳离画布时丢掉一整棵 React Flow 的状态，而管理台
//    内部根本没有 React Flow。见 components/Header.tsx 的注释。
//
// W4：桌面按 SETTINGS_TAB_GROUPS 分三组（组标题 + 图标 + 选中态）；手机仍是一条横向可滚的
// 平铺条，组标题不渲染（横条里插小标题只会占宽度）。
export function SettingsNav() {
  const segment = useSelectedLayoutSegment();

  return (
    <nav
      aria-label="设置分区"
      // 桌面：左侧竖排 rail（sticky 跟随滚动）。手机：横向可滚动的条（-mx 让它出血到容器边缘，
      // 否则滚到尽头时最后一个 tab 会被 padding 卡住看着像截断了）。
      className="
        flex flex-row gap-1 overflow-x-auto -mx-4 px-4 pb-2
        md:flex-col md:gap-0.5 md:overflow-visible md:mx-0 md:px-0 md:pb-0 md:w-[220px] md:shrink-0
        md:sticky md:top-[76px] md:self-start
      "
    >
      {SETTINGS_TAB_GROUPS.map((g, gi) => (
        <div key={g.id} role="group" aria-label={g.label} className="contents md:flex md:flex-col md:gap-0.5">
          <div
            aria-hidden
            className={cn(
              "hidden md:block px-2.5 pb-1.5 text-label text-ink-faint",
              gi === 0 ? "pt-0" : "pt-3.5",
            )}
          >
            {g.label}
          </div>
          {SETTINGS_TABS.filter((t) => t.group === g.id).map((t) => {
            const active = t.segment === segment;
            return (
              <Link
                key={t.segment}
                href={`/settings/${t.segment}`}
                title={t.title}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 flex items-center gap-2.5 px-2.5 h-8 rounded-field text-ui whitespace-nowrap transition-colors duration-100 max-md:min-h-11",
                  active
                    ? "bg-accent-muted text-accent-ink font-medium"
                    : "text-ink-muted hover:text-ink hover:bg-surface-hover",
                )}
              >
                <Icon
                  icon={TAB_ICONS[t.icon]}
                  selected={active}
                  className={active ? "text-accent-ink" : "text-ink-faint"}
                />
                {t.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
