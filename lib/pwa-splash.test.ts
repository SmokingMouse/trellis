import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SPLASH_DEVICES, splashFile, splashStartupImages } from "@/lib/pwa-splash";

const ICONS = join(import.meta.dir, "..", "public", "icons");

describe("pwa splash", () => {
  test("每个机型亮 / 暗两张都已生成（scripts/gen-pwa-splash.ts），且路径在 proxy 免登录的 /icons/*.png 下", () => {
    const images = splashStartupImages();
    expect(images.length).toBe(SPLASH_DEVICES.length * 2);
    for (const { url } of images) {
      expect(url).toMatch(/^\/icons\/[\w-]+\.png$/);
      expect(existsSync(join(ICONS, url.slice("/icons/".length)))).toBe(true);
    }
  });

  test("media 精确匹配逻辑尺寸 + DPR + 配色", () => {
    const [first] = splashStartupImages();
    const d = SPLASH_DEVICES[0];
    expect(first.media).toBe(
      `(device-width: ${d.width}px) and (device-height: ${d.height}px) and (-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: portrait) and (prefers-color-scheme: light)`,
    );
    expect(splashFile({ width: 390, height: 844, dpr: 3, models: "" }, "dark")).toBe("splash-1170x2532-dark.png");
  });

  test("文件名不重复", () => {
    const urls = splashStartupImages().map((i) => i.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
