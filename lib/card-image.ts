/**
 * Utilities for rendering and exporting shareable card images.
 * Pure calculation and data-handling logic extracted for reliability and testability.
 */

export const DEFAULT_EXPORT_PIXEL_RATIO = 2;
export const MIN_EXPORT_PIXEL_RATIO = 0.6;
export const DESKTOP_CANVAS_MAX_PIXELS = 48_000_000;
export const IOS_CANVAS_MAX_PIXELS = 14_000_000;
export const IOS_CANVAS_MAX_SIDE = 14_000;

export const CARD_DEFAULT_WIDTH = 680;
export const CARD_MAX_WIDTH = 1100;
export const CARD_PADDING = 64;

// 1x1 transparent PNG data URL used when an image fails to load during card rasterization,
// preventing html-to-image from throwing an uncaught error.
export const TRANSPARENT_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Detect iOS device (iPhone, iPad, iPod, or iPadOS in desktop Safari mode).
 */
export function isIOSDevice(
  ua?: string,
  platform?: string,
  maxTouchPoints?: number,
): boolean {
  if (ua === undefined && typeof navigator !== "undefined") {
    ua = navigator.userAgent;
    platform = navigator.platform;
    maxTouchPoints = navigator.maxTouchPoints;
  }
  const userAgent = ua || "";
  const isDirectIOS = /iPad|iPhone|iPod/i.test(userAgent);
  const isIPadDesktop = platform === "MacIntel" && (maxTouchPoints ?? 0) > 1;
  return isDirectIOS || isIPadDesktop;
}

export interface ExportPixelRatioOptions {
  width: number;
  height: number;
  isIos?: boolean;
  maxPixels?: number;
}

/**
 * Computes a safe export pixel ratio to prevent exceeding browser canvas limits.
 * On iOS Safari, total canvas memory cannot exceed 14M pixels, and side cannot exceed 14k px.
 */
export function computeExportPixelRatio(options: ExportPixelRatioOptions): number {
  const width = Math.max(1, Math.ceil(options.width));
  const height = Math.max(1, Math.ceil(options.height));
  const isIos = options.isIos ?? (typeof window !== "undefined" ? isIOSDevice() : false);
  const maxPixels = options.maxPixels ?? (isIos ? IOS_CANVAS_MAX_PIXELS : DESKTOP_CANVAS_MAX_PIXELS);

  let ratio = DEFAULT_EXPORT_PIXEL_RATIO;
  const areaAtDefault = width * height * ratio * ratio;
  if (areaAtDefault > maxPixels) {
    ratio = Math.sqrt(maxPixels / Math.max(width * height, 1));
  }

  if (isIos) {
    ratio = Math.min(ratio, IOS_CANVAS_MAX_SIDE / Math.max(width, height, 1));
  }

  return Math.max(
    MIN_EXPORT_PIXEL_RATIO,
    Math.min(DEFAULT_EXPORT_PIXEL_RATIO, ratio),
  );
}

export interface CardWidthOptions {
  defaultWidth?: number;
  maxWidth?: number;
  padding?: number;
}

/**
 * Computes optimal card width based on table scroll widths inside the content.
 * Prevents tables from being cropped while keeping non-table cards at defaultWidth.
 */
export function computeCardWidth(
  tableScrollWidths: number[],
  options?: CardWidthOptions,
): number {
  const defaultWidth = options?.defaultWidth ?? CARD_DEFAULT_WIDTH;
  const maxWidth = options?.maxWidth ?? CARD_MAX_WIDTH;
  const padding = options?.padding ?? CARD_PADDING;

  if (!tableScrollWidths.length) {
    return defaultWidth;
  }

  const maxTableWidth = Math.max(0, ...tableScrollWidths);
  if (maxTableWidth <= 0) {
    return defaultWidth;
  }

  return Math.max(defaultWidth, Math.min(maxTableWidth + padding, maxWidth));
}

/**
 * Checks if an image source is safe to paint directly on canvas without tainting.
 */
export function isSafeOverlayImageSrc(src: string, currentOrigin?: string): boolean {
  if (!src) return false;
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  try {
    const origin = currentOrigin || (typeof window !== "undefined" ? window.location.origin : "");
    if (!origin) return false;
    return new URL(src, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Infers image MIME type from URL/filename.
 */
export function inferImageMimeType(src: string, fallback?: string): string {
  if (fallback?.startsWith("image/")) return fallback;
  const clean = src.split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

/**
 * Converts a Blob to a Data URL.
 */
export function blobToDataUrl(blob: Blob, mimeType?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => resolve(String(reader.result || ""));
    const finalBlob =
      mimeType && !blob.type.startsWith("image/")
        ? new Blob([blob], { type: mimeType })
        : blob;
    reader.readAsDataURL(finalBlob);
  });
}

/**
 * Formats a clean download filename from title.
 */
export function formatCardDownloadFilename(title: string): string {
  const slug =
    title
      .slice(0, 40)
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "trellis-card";
  return `${slug}.png`;
}

/**
 * Waits for Mermaid diagrams and images inside the container to finish rendering.
 */
export function waitForRenderComplete(container: HTMLElement, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(timeout);
      setTimeout(resolve, 150);
    };

    const observer = new MutationObserver(check);
    const timeout = setTimeout(finish, timeoutMs);
    const watched = new WeakSet<HTMLImageElement>();

    function watchImage(img: HTMLImageElement) {
      if (watched.has(img) || img.complete) return;
      watched.add(img);
      const handler = () => check();
      img.addEventListener("load", handler, { once: true });
      img.addEventListener("error", handler, { once: true });
    }

    function check() {
      const loadingPulse = container.querySelectorAll(".animate-pulse");
      const textLoading = Array.from(container.querySelectorAll("div")).some((el) =>
        el.textContent?.includes("图表渲染中…"),
      );
      const images = container.querySelectorAll("img");
      images.forEach(watchImage);
      const allImagesLoaded = Array.from(images).every((img) => img.complete);
      if (loadingPulse.length === 0 && !textLoading && allImagesLoaded) {
        finish();
      }
    }

    observer.observe(container, { childList: true, subtree: true });
    check();
  });
}

export async function waitForImageReady(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return;
  if (img.complete) return;
  if (img.decode) {
    try {
      await img.decode();
      return;
    } catch {
      // Fall through to listeners
    }
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
    setTimeout(done, 3000);
  });
}

export async function setImageSrcAndWait(
  img: HTMLImageElement,
  src: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
    img.src = src;
    if (img.complete) resolve();
  });
  await waitForImageReady(img);
}

/**
 * html-to-image fails on blob: URLs when cacheBust is active, and re-fetches
 * same-origin images which can break in WebKit/PWA contexts.
 * Pre-inlines all images (blob: URLs, same-origin URLs) as data URLs.
 */
export async function inlineImagesAsDataUrls(container: HTMLElement): Promise<void> {
  const images = Array.from(container.querySelectorAll("img"));
  await Promise.all(
    images.map(async (img) => {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith("data:")) return;

      try {
        const res = await fetch(src, { credentials: "include" });
        if (!res.ok) return;
        const blob = await res.blob();
        img.srcset = "";
        const mimeType = inferImageMimeType(src, blob.type);
        const dataUrl = await blobToDataUrl(blob, mimeType);
        await setImageSrcAndWait(img, dataUrl);
      } catch {
        // Best effort: keep original src
      }
    }),
  );
}

export interface ImageOverlay {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getImageContentRect(
  img: HTMLImageElement,
  rootRect: DOMRect,
): ImageOverlay | null {
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const style = getComputedStyle(img);
  const borderLeft = parseFloat(style.borderLeftWidth || "0") || 0;
  const borderTop = parseFloat(style.borderTopWidth || "0") || 0;
  const borderRight = parseFloat(style.borderRightWidth || "0") || 0;
  const borderBottom = parseFloat(style.borderBottomWidth || "0") || 0;
  const width = Math.max(0, rect.width - borderLeft - borderRight);
  const height = Math.max(0, rect.height - borderTop - borderBottom);
  const src = img.currentSrc || img.src;
  if (!src || width <= 0 || height <= 0) return null;

  return {
    src,
    x: rect.left - rootRect.left + borderLeft,
    y: rect.top - rootRect.top + borderTop,
    width,
    height,
  };
}

export function collectImageOverlays(container: HTMLElement): ImageOverlay[] {
  const rootRect = container.getBoundingClientRect();
  return Array.from(container.querySelectorAll("img"))
    .map((img) => getImageContentRect(img, rootRect))
    .filter((overlay): overlay is ImageOverlay => overlay !== null && isSafeOverlayImageSrc(overlay.src));
}

/**
 * Re-paints image overlays onto the rasterized canvas to ensure 100% crisp rendering
 * on WebKit/Safari where foreignObject can distort images.
 */
export async function paintImageOverlays(
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  overlays: ImageOverlay[],
): Promise<void> {
  if (overlays.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rootRect = root.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(rootRect.width, 1);
  const scaleY = canvas.height / Math.max(rootRect.height, 1);

  const loaded = await Promise.all(
    overlays.map((overlay) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load overlay image"));
        img.src = overlay.src;
      }).then(
        (img) => ({ overlay, img }) as const,
        () => null,
      ),
    ),
  );

  for (const entry of loaded) {
    if (!entry) continue;
    const { overlay, img } = entry;
    ctx.drawImage(
      img,
      overlay.x * scaleX,
      overlay.y * scaleY,
      overlay.width * scaleX,
      overlay.height * scaleY,
    );
  }
}

/**
 * Triggers a browser download from a Blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/**
 * Triggers a browser download from a Data URL.
 */
export async function downloadFromDataUrl(dataUrl: string, filename: string): Promise<void> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  downloadBlob(blob, filename);
}
