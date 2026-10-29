#!/usr/bin/env bash
# 生成 PWA 用的 PNG 图标（public/icons/）。一次性产物入库，改了 logo 再跑一次：
#   bash scripts/gen-pwa-icons.sh
#
# 源图与 app/icon.svg / app/apple-icon.tsx 同一套品牌渐变 + 三节点字形。
# - icon-{192,512}.png：满版方形（不带圆角）—— iOS / Android 启动器自己会裁圆角，
#   预先画圆角会在 Android 上露出四个白角。
# - maskable-512.png：字形缩到 70%，落在 maskable 规范的 80% 安全圆内，任何形状的
#   遮罩（圆 / 水滴 / 方圆）都裁不到字形。
# - badge-96.png：Android 状态栏小图标，只认 alpha 通道，所以是透明底白字形。
set -euo pipefail
command -v rsvg-convert >/dev/null || { echo "需要 rsvg-convert（brew install librsvg）" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/public/icons"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

glyph='<g stroke="white" stroke-width="32" stroke-linecap="round" fill="white">
    <line x1="256" y1="170" x2="170" y2="340"/>
    <line x1="256" y1="170" x2="342" y2="340"/>
    <circle cx="256" cy="170" r="60"/>
    <circle cx="170" cy="340" r="60"/>
    <circle cx="342" cy="340" r="60"/>
  </g>'
grad='<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#6366f1"/>
    <stop offset="50%" stop-color="#d946ef"/>
    <stop offset="100%" stop-color="#fbbf24"/>
  </linearGradient></defs>'

cat >"$tmp/full.svg" <<EOF
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">$grad
  <rect width="512" height="512" fill="url(#g)"/>
  $glyph
</svg>
EOF

cat >"$tmp/maskable.svg" <<EOF
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">$grad
  <rect width="512" height="512" fill="url(#g)"/>
  <g transform="translate(256 256) scale(0.7) translate(-256 -256)">$glyph</g>
</svg>
EOF

cat >"$tmp/badge.svg" <<EOF
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(256 256) scale(1.15) translate(-256 -256)">$glyph</g>
</svg>
EOF

rsvg-convert -w 192 -h 192 "$tmp/full.svg" -o "$out/icon-192.png"
rsvg-convert -w 512 -h 512 "$tmp/full.svg" -o "$out/icon-512.png"
rsvg-convert -w 512 -h 512 "$tmp/maskable.svg" -o "$out/maskable-512.png"
rsvg-convert -w 96 -h 96 "$tmp/badge.svg" -o "$out/badge-96.png"
ls -la "$out"
