// 上传前的客户端图片压缩（手机拍照动辄 4000×3000 / 5MB+，直传既慢又费流量，
// 模型侧也会再缩一遍）。纯函数部分（尺寸计算、是否压缩、输出格式、改名）可单测；
// compressImageForUpload 依赖浏览器的 createImageBitmap + canvas。
//
// 规则：
//   - 只处理 jpeg / png / webp；gif（可能是动图）、svg、其它格式原样上传；
//   - 长边 ≤ maxEdge 且体积 ≤ maxBytes 的图不动（截图、草图保持原样，文字不糊）；
//   - 输出：png / webp 源 → webp（保留透明通道），jpeg 源 → jpeg；质量 0.85；
//   - EXIF 方向：createImageBitmap(file, { imageOrientation: "from-image" }) 先按方向
//     摆正再画进 canvas——重新编码会丢掉 EXIF，所以必须在像素层面转好；
//   - 压完反而更大且尺寸没变 → 用原图；解码 / 编码失败 → 用原图（压缩是尽力而为）。

export const COMPRESS_MAX_EDGE = 2048;
export const COMPRESS_QUALITY = 0.85;
/** 长边没超、但体积超过这个值也重新编码 */
export const COMPRESS_MAX_BYTES = 2 * 1024 * 1024;

const COMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/webp"]);

export type CompressOptions = {
  maxEdge?: number;
  quality?: number;
  maxBytes?: number;
};

export type CompressPlan =
  | { action: "keep" }
  | { action: "encode"; width: number; height: number; type: "image/jpeg" | "image/webp"; quality: number };

/** 等比缩到长边 ≤ maxEdge（不放大），结果取整且至少 1px。 */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const edge = Math.max(w, h);
  if (edge <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

export function isCompressibleImage(type: string): boolean {
  return COMPRESSIBLE.has(type);
}

/** 重新编码用的格式：jpeg 源保持 jpeg；png / webp 源用 webp（有透明通道也不丢）。 */
export function outputTypeFor(type: string): "image/jpeg" | "image/webp" {
  return type === "image/jpeg" ? "image/jpeg" : "image/webp";
}

/** 按（已摆正方向的）像素尺寸与体积决定压不压、压成什么。 */
export function planCompression(
  input: { type: string; size: number; width: number; height: number },
  opts: CompressOptions = {},
): CompressPlan {
  const maxEdge = opts.maxEdge ?? COMPRESS_MAX_EDGE;
  const maxBytes = opts.maxBytes ?? COMPRESS_MAX_BYTES;
  const quality = opts.quality ?? COMPRESS_QUALITY;
  if (!isCompressibleImage(input.type)) return { action: "keep" };
  if (!(input.width > 0 && input.height > 0)) return { action: "keep" };
  const tooLarge = Math.max(input.width, input.height) > maxEdge;
  if (!tooLarge && input.size <= maxBytes) return { action: "keep" };
  const { width, height } = fitWithin(input.width, input.height, maxEdge);
  return { action: "encode", width, height, type: outputTypeFor(input.type), quality };
}

/** 扩展名跟着输出格式走（服务端按扩展名校验）；没有文件名就保持 null。 */
export function renameForType(filename: string | null, type: string): string | null {
  if (!filename) return null;
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : null;
  if (!ext) return filename;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}.${ext}`;
}

/** 压缩结果比原图还大、且没缩尺寸 → 白忙一场，用原图。 */
export function keepOriginal(
  original: { size: number; width: number; height: number },
  encoded: { size: number; width: number; height: number },
): boolean {
  const resized = encoded.width < original.width || encoded.height < original.height;
  return !resized && encoded.size >= original.size;
}

export type CompressResult = {
  blob: Blob;
  filename: string | null;
  /** 是否真的重新编码了（false = 原样） */
  compressed: boolean;
  width?: number;
  height?: number;
};

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/** 浏览器端：按 planCompression 重新编码；任何一步不支持或失败都退回原图。 */
export async function compressImageForUpload(
  file: Blob,
  filename: string | null,
  opts: CompressOptions = {},
): Promise<CompressResult> {
  const original: CompressResult = { blob: file, filename, compressed: false };
  if (!isCompressibleImage(file.type)) return original;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return original;
  let bitmap: ImageBitmap | null = null;
  try {
    // from-image：按 EXIF Orientation 摆正（也是规范默认值，写明是为了老 Safari）。
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const plan = planCompression({ type: file.type, size: file.size, width: bitmap.width, height: bitmap.height }, opts);
    if (plan.action === "keep") return original;
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    if (plan.type === "image/jpeg") {
      // JPEG 没有透明通道：先铺白底，免得透明像素变黑。
      // ui-guard-allow(hex): canvas 像素底色，不是界面颜色
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, plan.width, plan.height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
    const blob = await encodeCanvas(canvas, plan.type, plan.quality);
    // 不支持 webp 编码的浏览器会悄悄回落成 png——那不是我们要的，用原图。
    if (!blob || blob.type !== plan.type) return original;
    if (keepOriginal({ size: file.size, width: bitmap.width, height: bitmap.height }, { size: blob.size, width: plan.width, height: plan.height })) {
      return original;
    }
    return { blob, filename: renameForType(filename, plan.type), compressed: true, width: plan.width, height: plan.height };
  } catch {
    return original;
  } finally {
    bitmap?.close();
  }
}
