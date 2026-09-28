import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Icon } from "@/components/ui";
import { SettingsNav } from "@/components/SettingsNav";

// S89: 管理台的壳。持久对象（有 CRUD、跨 session 存活、被 id 引用）都住在这里的 tab 下，
// 见 lib/settings-tabs.ts 与 decisions/2026-07-31-console-ia.md。
//
// 这个 layout 接管了两件原本每张整页各写一遍的事：
// ① 滚动容器 —— globals.css 把 html/body 焊成 overflow:hidden（SPA canvas 要的），
//    所以脱离 SPA 的整页必须自带 h-dvh + overflow-y-auto，否则编辑器一超过视口高度
//    底部的保存按钮就永远够不着。原来 agents 页和 tasks 页各带一份、注释都写着同一条理由。
// ② 页间互链 —— 原本三张页手写六个方向的链接，还漏了一条（agents 不链 tasks）。
//    tab 导航天然是全连通的，加 tab 不用再补链。
//
// layout 不重渲染（Next 会在导航间缓存它），所以高亮态必须由客户端组件自己读段，
// 不能在这里算 —— 见 SettingsNav 的注释。
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-dvh overflow-y-auto bg-surface-canvas text-ink">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-line bg-surface-canvas px-4 md:px-5">
        {/* 返回用 <Link>（三张页原本就都是 Link）。「用 <a> 硬导航」那条规矩只管**出去**
            的方向 —— Header 上点设置时要让浏览器真换一页，别背着一整棵 React Flow 走；
            回来时画布本来就没在跑，没有东西要丢，用不着再赔一次整页加载。 */}
        <Link
          href="/"
          className="-ml-1.5 inline-flex items-center gap-1.5 rounded-field px-1.5 h-8 text-ui text-ink-muted transition-colors duration-100 hover:bg-surface-hover hover:text-ink max-md:min-h-11"
        >
          <Icon icon={ArrowLeft} />
          返回工作台
        </Link>
        <span aria-hidden className="h-4.5 w-px bg-line" />
        <span className="text-ui font-semibold text-ink-strong">设置</span>
      </header>

      {/* W4 统一 PageShell：左 220px 分组导航 + 右内容区，内容区一律 max-w-[880px]
          （原来各页自带 612 / 770 / 900 三种宽度，子页不再自己设最大宽度）。 */}
      <div className="mx-auto flex max-w-[1180px] flex-col gap-4 p-4 pb-24 md:flex-row md:gap-10 md:px-8 md:pt-7">
        <SettingsNav />
        <div className="min-w-0 flex-1 md:max-w-[880px]">{children}</div>
      </div>
    </div>
  );
}
