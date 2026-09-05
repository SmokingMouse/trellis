import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PREF_KEYS } from "@/lib/prefs";

export const metadata: Metadata = {
  title: "Trellis",
  description: "图状的 AI 对话",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Trellis",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#fafaf9",
  // Browser pinch-zoom is disabled so React Flow can own the gesture.
  // The canvas zoom replaces accessibility zoom for this app.
  userScalable: false,
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
  } catch (_) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
