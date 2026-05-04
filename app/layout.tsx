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
// localStorage key + system-pref fallback the runtime hook uses; keep
// them in sync if you change either.
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('trellis-theme');
    var t = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (t === 'dark') document.documentElement.classList.add('dark');
  } catch (_) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
