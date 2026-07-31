"use client";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";
import { SETTINGS_TABS } from "@/lib/settings-tabs";

// S89: 管理台的 tab 导航。
//
// 两件事值得写下来：
// ① 用 useSelectedLayoutSegment 而不是 usePathname —— 它直接返回 layout 下一级的段
//    （agents / tasks / update），不用做字符串前缀匹配，也就不会在将来出现
//    /settings/agents/[id] 这种子路由时把高亮判错。
// ② tab 之间用 <Link>（客户端跳转，layout 不重渲染）。这与「主 SPA ↔ 管理台之间用 <a>
//    硬导航」不矛盾：那条规矩是为了跳离画布时丢掉一整棵 React Flow 的状态，而管理台
//    内部根本没有 React Flow。见 components/Header.tsx 的注释。
export function SettingsNav() {
  const segment = useSelectedLayoutSegment();

  return (
    <nav
      aria-label="设置分区"
      // 桌面：左侧竖排 rail。手机：横向可滚动的条（-mx 让它出血到容器边缘，
      // 否则滚到尽头时最后一个 tab 会被 padding 卡住看着像截断了）。
      className="
        flex flex-row gap-1 overflow-x-auto -mx-4 px-4 pb-2
        md:flex-col md:overflow-visible md:mx-0 md:px-0 md:pb-0 md:w-[180px] md:shrink-0
      "
    >
      {SETTINGS_TABS.map((t) => {
        const active = t.segment === segment;
        return (
          <Link
            key={t.segment}
            href={`/settings/${t.segment}`}
            title={t.title}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 flex items-center gap-2 px-3 h-8 rounded-md text-ui whitespace-nowrap ${
              active
                ? "bg-accent-muted text-accent-ink font-medium"
                : "text-ink-muted hover:text-ink hover:bg-surface-muted"
            }`}
          >
            <span aria-hidden className="text-[13px] leading-none">
              {t.icon}
            </span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
