import { describe, expect, test } from "bun:test";
import {
  COMPRESS_MAX_BYTES,
  fitWithin,
  keepOriginal,
  outputTypeFor,
  planCompression,
  renameForType,
} from "./image-compress";

describe("fitWithin", () => {
  test("长边超限等比缩到 maxEdge", () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
  });
  test("不放大小图", () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });
  test("极端长图至少 1px", () => {
    expect(fitWithin(20000, 3, 2048)).toEqual({ width: 2048, height: 1 });
  });
});

describe("planCompression", () => {
  test("大尺寸 jpeg → 缩放并保持 jpeg", () => {
    expect(planCompression({ type: "image/jpeg", size: 5_000_000, width: 4032, height: 3024 })).toEqual({
      action: "encode",
      width: 2048,
      height: 1536,
      type: "image/jpeg",
      quality: 0.85,
    });
  });
  test("png 源输出 webp（保留透明）", () => {
    const plan = planCompression({ type: "image/png", size: 100, width: 3000, height: 1000 });
    expect(plan).toMatchObject({ action: "encode", type: "image/webp", width: 2048, height: 683 });
  });
  test("尺寸没超但体积超限也重编码、不改尺寸", () => {
    const plan = planCompression({ type: "image/jpeg", size: COMPRESS_MAX_BYTES + 1, width: 2000, height: 1500 });
    expect(plan).toMatchObject({ action: "encode", width: 2000, height: 1500 });
  });
  test("小图、gif、svg、未知尺寸都原样", () => {
    expect(planCompression({ type: "image/jpeg", size: 300_000, width: 1200, height: 900 })).toEqual({ action: "keep" });
    expect(planCompression({ type: "image/gif", size: 9_000_000, width: 4000, height: 4000 })).toEqual({ action: "keep" });
    expect(planCompression({ type: "image/svg+xml", size: 9_000_000, width: 4000, height: 4000 })).toEqual({ action: "keep" });
    expect(planCompression({ type: "image/jpeg", size: 9_000_000, width: 0, height: 0 })).toEqual({ action: "keep" });
  });
  test("可调 maxEdge / quality", () => {
    expect(planCompression({ type: "image/webp", size: 1, width: 1000, height: 500 }, { maxEdge: 500, quality: 0.7 })).toEqual({
      action: "encode",
      width: 500,
      height: 250,
      type: "image/webp",
      quality: 0.7,
    });
  });
});

describe("outputTypeFor / renameForType", () => {
  test("输出格式", () => {
    expect(outputTypeFor("image/jpeg")).toBe("image/jpeg");
    expect(outputTypeFor("image/png")).toBe("image/webp");
    expect(outputTypeFor("image/webp")).toBe("image/webp");
  });
  test("扩展名跟着格式走", () => {
    expect(renameForType("IMG_0001.PNG", "image/webp")).toBe("IMG_0001.webp");
    expect(renameForType("photo.jpeg", "image/jpeg")).toBe("photo.jpg");
    expect(renameForType("a.b.png", "image/webp")).toBe("a.b.webp");
    expect(renameForType(".hidden", "image/jpeg")).toBe(".hidden.jpg");
    expect(renameForType("noext", "image/jpeg")).toBe("noext.jpg");
    expect(renameForType(null, "image/jpeg")).toBeNull();
  });
});

describe("keepOriginal", () => {
  test("没缩尺寸且更大 → 用原图", () => {
    expect(keepOriginal({ size: 100, width: 10, height: 10 }, { size: 120, width: 10, height: 10 })).toBe(true);
  });
  test("缩了尺寸 → 用压缩结果", () => {
    expect(keepOriginal({ size: 100, width: 4000, height: 3000 }, { size: 120, width: 2048, height: 1536 })).toBe(false);
  });
  test("同尺寸但更小 → 用压缩结果", () => {
    expect(keepOriginal({ size: 100, width: 10, height: 10 }, { size: 50, width: 10, height: 10 })).toBe(false);
  });
});
