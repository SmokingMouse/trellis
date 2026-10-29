#!/usr/bin/env bun
// 生成 iOS 主屏 PWA 启动图（public/icons/splash-*.png）。一次性产物入库，改了 logo / 底色 /
// 机型清单（lib/pwa-splash.ts）再跑一次：
//   bun scripts/gen-pwa-splash.ts
//
// 做法同 scripts/gen-pwa-icons.sh：手写 SVG → rsvg-convert 出 PNG。纯色画布（亮 / 暗两套，
// 与 theme-color 同色）+ 居中 logo（app/icon.svg 同一套品牌渐变圆角方块 + 三节点字形），
// logo 边长 96pt × DPR —— 和 iOS 原生 App 启动屏的图标视觉尺寸相当，冷启动从启动图过渡到
// 首屏骨架（app/page.tsx BootSkeleton）时不会「跳」一下。
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPLASH_BACKGROUND, SPLASH_DEVICES, splashFile, type SplashScheme } from "../lib/pwa-splash";

const LOGO_PT = 96;

if (!Bun.which("rsvg-convert")) {
  console.error("需要 rsvg-convert（brew install librsvg）");
  process.exit(1);
}

const root = join(import.meta.dir, "..");
const out = join(root, "public", "icons");
const tmp = mkdtempSync(join(tmpdir(), "trellis-splash-"));
mkdirSync(out, { recursive: true });

// 512 坐标系下的 logo（与 gen-pwa-icons.sh 同源），外面套圆角（iOS 图标的 ~22.4% 圆角）
const logo = (x: number, y: number, size: number) => `
  <g transform="translate(${x} ${y}) scale(${size / 512})">
    <rect width="512" height="512" rx="115" fill="url(#g)"/>
    <g stroke="white" stroke-width="32" stroke-linecap="round" fill="white">
      <line x1="256" y1="170" x2="170" y2="340"/>
      <line x1="256" y1="170" x2="342" y2="340"/>
      <circle cx="256" cy="170" r="60"/>
      <circle cx="170" cy="340" r="60"/>
      <circle cx="342" cy="340" r="60"/>
    </g>
  </g>`;

const grad = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#6366f1"/>
    <stop offset="50%" stop-color="#d946ef"/>
    <stop offset="100%" stop-color="#fbbf24"/>
  </linearGradient></defs>`;

try {
  let count = 0;
  for (const d of SPLASH_DEVICES) {
    const w = d.width * d.dpr;
    const h = d.height * d.dpr;
    const size = LOGO_PT * d.dpr;
    for (const scheme of Object.keys(SPLASH_BACKGROUND) as SplashScheme[]) {
      const svg = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${grad}
  <rect width="${w}" height="${h}" fill="${SPLASH_BACKGROUND[scheme]}"/>${logo((w - size) / 2, (h - size) / 2, size)}
</svg>`;
      const src = join(tmp, `${w}x${h}-${scheme}.svg`);
      writeFileSync(src, svg);
      const file = join(out, splashFile(d, scheme));
      const r = Bun.spawnSync(["rsvg-convert", "-w", String(w), "-h", String(h), src, "-o", file]);
      if (r.exitCode !== 0) throw new Error(`rsvg-convert 失败：${file}\n${r.stderr.toString()}`);
      count++;
    }
  }
  console.log(`已生成 ${count} 张启动图 → ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
