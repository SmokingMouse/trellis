"use client";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import {
  Bot,
  CalendarClock,
  ChevronRight,
  CircleArrowUp,
  Cpu,
  KeyRound,
  MessagesSquare,
  Network,
  Server,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { GlideList, Icon, cn } from "@/components/ui";
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
  "shield-check": ShieldCheck,
  "key-round": KeyRound,
  "circle-arrow-up": CircleArrowUp,
  network: Network,
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
//
// 2026-10-30 视觉改版（原型 .set-nav）：桌面是设置浮窗里带右侧分隔线的竖栏，组标题小号
// ink-faint，每组一块 GlideList 悬停滑块；选中行 = hover 底 + ink（不再用 accent 底）。
export function SettingsNav() {
  const segment = useSelectedLayoutSegment();

  return (
    <nav
      aria-label="设置分区"
      // 桌面：左侧竖排 rail（sticky 跟随滚动）。手机：横向可滚动的条（-mx 让它出血到容器边缘，
      // 否则滚到尽头时最后一个 tab 会被 padding 卡住看着像截断了）。
      className="
        flex flex-row gap-1 overflow-x-auto -mx-4 px-4 pb-2
        md:flex-col md:gap-0 md:overflow-y-auto md:mx-0 md:px-2 md:py-4 md:w-[208px] md:shrink-0
        md:border-r md:border-line
      "
    >
      {SETTINGS_TAB_GROUPS.map((g, gi) => (
        <div key={g.id} role="group" aria-label={g.label} className="contents md:flex md:flex-col">
          <div
            aria-hidden
            className={cn(
              "hidden md:block px-2 pb-2 text-label font-medium text-ink-faint",
              gi === 0 ? "pt-0" : "pt-3.5",
            )}
          >
            {g.label}
          </div>
          <GlideList className="contents md:flex md:flex-col md:gap-px max-md:[&>.ui-glide-hl]:hidden">
          {SETTINGS_TABS.filter((t) => t.group === g.id).map((t) => {
            const active = t.segment === segment;
            return (
              <Link
                key={t.segment}
                href={`/settings/${t.segment}`}
                title={t.title}
                aria-current={active ? "page" : undefined}
                data-glide-row
                className={cn(
                  "press-row shrink-0 flex items-center gap-2 px-2 h-8 rounded-field text-ui md:text-[13.5px] md:font-medium whitespace-nowrap transition-colors duration-150 max-md:min-h-11",
                  active
                    ? "bg-surface-hover text-ink"
                    : "text-ink-muted hover:text-ink hover:bg-surface-hover",
                )}
              >
                <Icon
                  icon={TAB_ICONS[t.icon]}
                  selected={active}
                  className={cn("md:size-3.5", active ? "text-ink" : "text-ink-faint")}
                />
                {t.label}
              </Link>
            );
          })}
          </GlideList>
        </div>
      ))}
    </nav>
  );
}

// 2026-10-30 设置顶栏面包屑「设置 › <页面名>」：和 SettingsNav 一样得在客户端读段
// （layout 在 tab 间不重渲染）。手机顶栏只显示「设置」，与原来一致。
export function SettingsBreadcrumb() {
  const segment = useSelectedLayoutSegment();
  const tab = SETTINGS_TABS.find((t) => t.segment === segment);
  return (
    <div className="flex min-w-0 items-center gap-1 text-ui md:text-[13px]">
      <span className="font-semibold text-ink-strong md:font-normal md:text-ink-muted">设置</span>
      {tab && (
        <>
          <Icon icon={ChevronRight} size="sm" className="hidden text-ink-faint md:inline-flex" />
          <span aria-current="page" className="hidden truncate font-medium text-ink md:inline">
            {tab.label}
          </span>
        </>
      )}
    </div>
  );
}
