// iOS 主屏 PWA 的启动图（apple-touch-startup-image）。iOS 只认「尺寸与设备完全一致」的那张，
// 对不上就是白屏，所以按主流 iPhone 的逻辑分辨率 × DPR 各出一张，亮 / 暗两套靠
// prefers-color-scheme 区分。生成脚本 scripts/gen-pwa-splash.ts 与 app/layout.tsx 的
// metadata.appleWebApp.startupImage 共用这一份清单 —— 加机型只改这里，再跑一次脚本。
//
// 文件放 public/icons/：proxy.ts 已对 /icons/*.png 免登录（iOS 取启动图不带 cookie）。

export type SplashDevice = { width: number; height: number; dpr: number; models: string };

// 逻辑分辨率（pt，竖屏）。同一分辨率不同 DPR 的机型（XR / 11 与 XS Max / 11 Pro Max）分开列。
export const SPLASH_DEVICES: SplashDevice[] = [
  { width: 440, height: 956, dpr: 3, models: "16 Pro Max / 17 Pro Max" },
  { width: 420, height: 912, dpr: 3, models: "Air" },
  { width: 402, height: 874, dpr: 3, models: "16 Pro / 17 / 17 Pro" },
  { width: 430, height: 932, dpr: 3, models: "14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus" },
  { width: 393, height: 852, dpr: 3, models: "14 Pro / 15 / 15 Pro / 16 / 16e" },
  { width: 428, height: 926, dpr: 3, models: "12 Pro Max / 13 Pro Max / 14 Plus" },
  { width: 390, height: 844, dpr: 3, models: "12 / 12 Pro / 13 / 13 Pro / 14" },
  { width: 375, height: 812, dpr: 3, models: "X / XS / 11 Pro / 12 mini / 13 mini" },
  { width: 414, height: 896, dpr: 3, models: "XS Max / 11 Pro Max" },
  { width: 414, height: 896, dpr: 2, models: "XR / 11" },
  { width: 414, height: 736, dpr: 3, models: "6+ / 7+ / 8 Plus" },
  { width: 375, height: 667, dpr: 2, models: "6 / 7 / 8 / SE 2 / SE 3" },
];

/** 画布底色：与 app/layout.tsx viewport.themeColor、globals.css --surface-canvas 同值。 */
export const SPLASH_BACKGROUND = { light: "#fafafa", dark: "#0b0b0c" } as const; // ui-guard-allow(hex): 启动图是 PNG，读不到 CSS 变量

export type SplashScheme = keyof typeof SPLASH_BACKGROUND;

export function splashFile(d: SplashDevice, scheme: SplashScheme): string {
  return `splash-${d.width * d.dpr}x${d.height * d.dpr}-${scheme}.png`;
}

export function splashMedia(d: SplashDevice, scheme: SplashScheme): string {
  return (
    `(device-width: ${d.width}px) and (device-height: ${d.height}px) and ` +
    `(-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: portrait) and ` +
    `(prefers-color-scheme: ${scheme})`
  );
}

export function splashStartupImages(): { url: string; media: string }[] {
  return SPLASH_DEVICES.flatMap((d) =>
    (["light", "dark"] as const).map((scheme) => ({
      url: `/icons/${splashFile(d, scheme)}`,
      media: splashMedia(d, scheme),
    })),
  );
}
