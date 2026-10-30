import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Icon } from "@/components/ui";
import { SettingsBreadcrumb, SettingsNav } from "@/components/SettingsNav";

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
    // 2026-10-30 视觉改版（原型 docs/ui-redesign/mockups/08-beautiful-ui.html「设置」屏）：
    // 桌面是 canvas 上四边各留 8px 的一扇浮窗（14px 圆角 + 叠层阴影），窗内顶栏 48px、左侧
    // 分组导航带竖分隔线、右侧内容区自己滚动。手机仍是原来的整页单滚动容器 + sticky 顶栏 +
    // 横向 tab 条（md: 以外的类与原来一致）。
    <div className="h-dvh overflow-y-auto bg-surface-canvas text-ink md:overflow-hidden md:p-2">
      <div className="md:flex md:h-full md:flex-col md:overflow-hidden md:rounded-window md:bg-surface md:shadow-raise">
        {/* 桌面顶栏：返回链接的图标与左侧导航的图标同一条竖线（都在窗内 16px），后接竖分隔
            + 面包屑「设置 › 页面名」。 */}
        <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-line bg-surface-canvas px-4 md:static md:shrink-0 md:gap-2 md:bg-surface md:pl-2 md:pr-4">
          {/* 返回用 <Link>（三张页原本就都是 Link）。「用 <a> 硬导航」那条规矩只管**出去**
              的方向 —— Header 上点设置时要让浏览器真换一页，别背着一整棵 React Flow 走；
              回来时画布本来就没在跑，没有东西要丢，用不着再赔一次整页加载。 */}
          <Link
            href="/"
            className="-ml-1.5 inline-flex items-center gap-1.5 rounded-field px-1.5 h-8 text-ui text-ink-muted transition-colors duration-100 hover:bg-surface-hover hover:text-ink max-md:min-h-11 md:ml-0 md:px-2"
          >
            <Icon icon={ArrowLeft} />
            返回工作台
          </Link>
          <span aria-hidden className="h-4 w-px bg-line" />
          <SettingsBreadcrumb />
        </header>

        {/* W4 统一 PageShell：左侧分组导航 + 右内容区。
            2026-10-30：内容列靠左、四边 32/28px 内边距、最宽 1120px（原来 880px 居中，1280 宽时
            两侧各空 ~90px，列表 + 详情页显得偏且挤）。表单类页（偏好、登录）自己再收到 760px。 */}
        <div className="mx-auto flex max-w-[1180px] flex-col gap-4 p-4 pb-24 md:mx-0 md:min-h-0 md:max-w-none md:flex-1 md:flex-row md:gap-0 md:p-0">
          <SettingsNav />
          <div className="min-w-0 flex-1 md:overflow-y-auto">
            <div className="md:max-w-[1120px] md:px-8 md:pb-20 md:pt-7">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
