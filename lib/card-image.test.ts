import { describe, expect, test } from "bun:test";
import {
  CARD_DEFAULT_WIDTH,
  CARD_MAX_WIDTH,
  DEFAULT_EXPORT_PIXEL_RATIO,
  MIN_EXPORT_PIXEL_RATIO,
  computeCardWidth,
  computeExportPixelRatio,
  formatCardDownloadFilename,
  inferImageMimeType,
  isIOSDevice,
  isSafeOverlayImageSrc,
} from "./card-image";

describe("isIOSDevice", () => {
  test("identifies iPhone, iPad, and iPod from UA", () => {
    expect(
      isIOSDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"),
    ).toBe(true);
    expect(
      isIOSDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"),
    ).toBe(true);
    expect(
      isIOSDevice("Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X)"),
    ).toBe(true);
  });

  test("identifies iPadOS Safari desktop UA via MacIntel and touch points", () => {
    expect(
      isIOSDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        "MacIntel",
        5,
      ),
    ).toBe(true);
    expect(
      isIOSDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        "MacIntel",
        0,
      ),
    ).toBe(false);
  });

  test("returns false for non-iOS devices", () => {
    expect(
      isIOSDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"),
    ).toBe(false);
    expect(
      isIOSDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0.0.0"),
    ).toBe(false);
  });
});

describe("computeExportPixelRatio", () => {
  test("returns default 2 for normal card dimensions", () => {
    const ratio = computeExportPixelRatio({ width: 680, height: 1200, isIos: false });
    expect(ratio).toBe(DEFAULT_EXPORT_PIXEL_RATIO);
  });

  test("scales down desktop ratio when canvas area exceeds DESKTOP_CANVAS_MAX_PIXELS", () => {
    // 680 * 40,000 = 27.2M. At ratio 2, 27.2M * 4 = 108.8M > 48M limit
    const ratio = computeExportPixelRatio({ width: 680, height: 40_000, isIos: false });
    expect(ratio).toBeLessThan(DEFAULT_EXPORT_PIXEL_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_EXPORT_PIXEL_RATIO);
    const totalPixels = 680 * ratio * (40_000 * ratio);
    expect(totalPixels).toBeLessThanOrEqual(48_000_001);
  });

  test("clamps to MIN_EXPORT_PIXEL_RATIO when dimensions are extremely huge", () => {
    const ratio = computeExportPixelRatio({ width: 2000, height: 100_000, isIos: false });
    expect(ratio).toBe(MIN_EXPORT_PIXEL_RATIO);
  });

  test("respects iOS 14M pixels and 14k side limits", () => {
    // Height 10,000 on iOS: 14,000 / 10,000 = 1.4 max ratio
    const ratio = computeExportPixelRatio({ width: 680, height: 10_000, isIos: true });
    expect(ratio).toBeLessThanOrEqual(1.4);
    expect(ratio * 10_000).toBeLessThanOrEqual(14_000);
    const totalPixels = 680 * ratio * (10_000 * ratio);
    expect(totalPixels).toBeLessThanOrEqual(14_000_001);
  });
});

describe("computeCardWidth", () => {
  test("returns default width when there are no tables or 0-width tables", () => {
    expect(computeCardWidth([])).toBe(CARD_DEFAULT_WIDTH);
    expect(computeCardWidth([0])).toBe(CARD_DEFAULT_WIDTH);
  });

  test("expands width to fit tables up to CARD_MAX_WIDTH", () => {
    expect(computeCardWidth([700])).toBe(700 + 64);
    expect(computeCardWidth([800, 600])).toBe(800 + 64);
    expect(computeCardWidth([1500])).toBe(CARD_MAX_WIDTH);
  });

  test("honors custom width options", () => {
    expect(
      computeCardWidth([500], { defaultWidth: 600, maxWidth: 1200, padding: 40 }),
    ).toBe(600);
    expect(
      computeCardWidth([700], { defaultWidth: 600, maxWidth: 1200, padding: 40 }),
    ).toBe(740);
  });
});

describe("isSafeOverlayImageSrc", () => {
  test("allows data: and blob: URLs", () => {
    expect(isSafeOverlayImageSrc("data:image/png;base64,abc")).toBe(true);
    expect(isSafeOverlayImageSrc("blob:http://localhost:3488/uuid")).toBe(true);
  });

  test("allows same-origin URLs and relative paths", () => {
    expect(isSafeOverlayImageSrc("/api/files/test.png", "http://localhost:3488")).toBe(true);
    expect(isSafeOverlayImageSrc("http://localhost:3488/test.png", "http://localhost:3488")).toBe(true);
  });

  test("rejects cross-origin URLs", () => {
    expect(isSafeOverlayImageSrc("https://example.com/test.png", "http://localhost:3488")).toBe(false);
  });

  test("returns false for invalid or empty inputs", () => {
    expect(isSafeOverlayImageSrc("")).toBe(false);
  });
});

describe("inferImageMimeType", () => {
  test("infers MIME type from extension", () => {
    expect(inferImageMimeType("photo.jpg")).toBe("image/jpeg");
    expect(inferImageMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(inferImageMimeType("diagram.png")).toBe("image/png");
    expect(inferImageMimeType("vector.svg")).toBe("image/svg+xml");
    expect(inferImageMimeType("anim.webp")).toBe("image/webp");
    expect(inferImageMimeType("anim.gif")).toBe("image/gif");
  });

  test("ignores query parameters and hashes", () => {
    expect(inferImageMimeType("photo.png?w=200#anchor")).toBe("image/png");
  });

  test("uses fallback when provided", () => {
    expect(inferImageMimeType("unknown-file", "image/webp")).toBe("image/webp");
  });
});

describe("formatCardDownloadFilename", () => {
  test("formats alphanumeric and unicode titles", () => {
    expect(formatCardDownloadFilename("Hello World")).toBe("Hello-World.png");
    expect(formatCardDownloadFilename("解决跨域问题")).toBe("解决跨域问题.png");
  });

  test("replaces special characters and strips trailing dashes", () => {
    expect(formatCardDownloadFilename("test: foo / bar? *")).toBe("test-foo-bar.png");
  });

  test("falls back to default for empty or invalid strings", () => {
    expect(formatCardDownloadFilename("")).toBe("trellis-card.png");
    expect(formatCardDownloadFilename("???")).toBe("trellis-card.png");
  });
});
