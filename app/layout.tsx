import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { PREF_KEYS } from "@/lib/prefs";
import { AppProviders } from "@/components/ui/AppProviders";
import { splashStartupImages } from "@/lib/pwa-splash";

export const metadata: Metadata = {
  title: "Trellis",
  description: "图状的 AI 对话",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Trellis",
    // iOS 主屏启动图：按机型尺寸 × 亮 / 暗各一张（lib/pwa-splash.ts，scripts/gen-pwa-splash.ts 生成）。
    // 没有它，主屏图标点开到首屏骨架之间是一块白屏。
    startupImage: splashStartupImages(),
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  // Android Chrome 弹键盘时缩 layout viewport，底部输入框自然留在键盘上方；
  // iOS 忽略此项，由 hooks/useKeyboardInset 读 visualViewport 兜住。
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" }, // ui-guard-allow(hex): viewport themeColor 是 <meta>，读不到 CSS 变量
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0c" }, // ui-guard-allow(hex): 同上
  ],
  // Keep document zoom accessible; the React Flow surface owns gestures
  // locally via touch-action instead of disabling zoom for the whole app.
  userScalable: true,
};

// Pre-hydration theme application. Runs before React touches the DOM so
// users never see a flash of the wrong theme (FOUC). Same resolution logic as
// hooks/useTheme.ts. `trellis-theme` stores light/dark/system (legacy two-value
// entries stay valid; missing = system). `trellis-palette` stores the skin id;
// 'default' carries no data-theme attribute.
//
// S89: key 名从 lib/prefs.ts **插值进来**，不再手写字面量。此前这里和 useTheme.ts
// 各硬编码一份，注释写着「keep them in sync if you change either」—— 那种靠人记得
// 同步的约定迟早失效，现在物理上不可能不同步。
const themeScript = `
(function() {
  try {
    var m = localStorage.getItem('${PREF_KEYS.theme}');
    var dark = m === 'dark' || (m !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
    var p = localStorage.getItem('${PREF_KEYS.palette}');
    if (p && p !== 'default') document.documentElement.setAttribute('data-theme', p);
    // theme-color 对齐画布色（同 hooks/useTheme.ts syncThemeColorMeta）。脚本在 <head>
    // 里跑时 meta 可能还没解析到，DOMContentLoaded 再补一次。
    var syncMeta = function() {
      var c = getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim();
      if (!c) return;
      var ms = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < ms.length; i++) { ms[i].removeAttribute('media'); ms[i].setAttribute('content', c); }
    };
    syncMeta();
    document.addEventListener('DOMContentLoaded', syncMeta);
  } catch (_) {}
})();
`;

// Inter / JetBrains Mono（均 OFL，app/fonts/*-OFL.txt）本地托管：不依赖外网字体 CDN。
// 与 beautifului.dev 同款字体（2026-10-30 视觉改版）。只含拉丁子集，中文按
// globals.css 的 font-family 回退到 PingFang。
const interSans = localFont({
  src: "./fonts/Inter-Variable.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});
const jetbrainsMono = localFont({
  src: "./fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-jetbrains-mono",
  weight: "100 800",
  display: "swap",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={`h-full antialiased ${interSans.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
