import type { Metadata, Viewport } from "next";
import "./globals.css";

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
  // Browser pinch-zoom is disabled so React Flow can own the gesture.
  // The canvas zoom replaces accessibility zoom for this app.
  userScalable: false,
};

// Pre-hydration theme application. Runs before React touches the DOM so
// users never see a flash of the wrong theme (FOUC). Mirrors the same
// localStorage keys + resolution logic hooks/useTheme.ts uses; keep them
// in sync if you change either. 'trellis-theme' stores light/dark/system
// (legacy two-value entries stay valid; missing = system). 'trellis-palette'
// stores the skin id; 'default' carries no data-theme attribute.
const themeScript = `
(function() {
  try {
    var m = localStorage.getItem('trellis-theme');
    var dark = m === 'dark' || (m !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
    var p = localStorage.getItem('trellis-palette');
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
