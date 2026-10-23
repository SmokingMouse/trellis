// Pure utility functions for SVG detection, extraction, normalization, and export.

export function isSvgLang(lang: string): boolean {
  const l = (lang || "").toLowerCase().trim();
  return l === "svg" || l === "image/svg+xml";
}

export function isPotentialSvgLang(lang: string): boolean {
  const l = (lang || "").toLowerCase().trim();
  return (
    !l ||
    l === "svg" ||
    l === "xml" ||
    l === "html" ||
    l === "markup" ||
    l === "code" ||
    l === "text"
  );
}

/**
 * Extracts the outermost <svg ...>...</svg> substring from a raw text block,
 * ignoring any leading <?xml ...?>, <!DOCTYPE ...>, or comments.
 */
export function extractSvg(rawText: string): string | null {
  if (!rawText) return null;
  const trimmed = rawText.trim();
  const start = trimmed.indexOf("<svg");
  if (start === -1) return null;

  // Make sure it looks like a tag start, e.g. `<svg ` or `<svg>` or `<svg\n`
  const nextChar = trimmed[start + 4];
  if (nextChar !== " " && nextChar !== "\n" && nextChar !== "\t" && nextChar !== ">" && nextChar !== "/") {
    return null;
  }

  const end = trimmed.lastIndexOf("</svg>");
  if (end === -1 || end < start) return null;

  return trimmed.slice(start, end + 6);
}

/**
 * Checks whether a code block represents an SVG diagram/graphic.
 */
export function isSvgCode(code: string, lang?: string): boolean {
  if (!code) return false;
  if (isSvgLang(lang ?? "")) {
    return /<svg[\s>/]/i.test(code) && /<\/svg>\s*$/i.test(code.trim());
  }
  if (isPotentialSvgLang(lang ?? "")) {
    const extracted = extractSvg(code);
    return extracted !== null && extracted.length > 15;
  }
  return false;
}

/**
 * Normalizes SVG text:
 * 1. Ensures xmlns="http://www.w3.org/2000/svg" exists (many LLMs omit it, causing img blob parse errors).
 * 2. Adds fallback viewBox if width & height are specified without a viewBox.
 * 3. Strips <script> tags and inline on* event handlers for defense-in-depth safety.
 */
export function normalizeSvg(rawSvg: string): string {
  const extracted = extractSvg(rawSvg) ?? rawSvg.trim();
  let result = extracted;

  // 1. Ensure xmlns attribute is present in <svg> tag
  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(result)) {
    result = result.replace(/<svg\b([^>]*)>/i, '<svg xmlns="http://www.w3.org/2000/svg" $1>');
  }

  // 2. Add viewBox if missing but numeric width and height are present
  if (!/viewBox\s*=/i.test(result)) {
    const widthMatch = /<svg\b[^>]*\bwidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i.exec(result);
    const heightMatch = /<svg\b[^>]*\bheight\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i.exec(result);
    if (widthMatch && heightMatch) {
      const w = widthMatch[1];
      const h = heightMatch[1];
      result = result.replace(/<svg\b([^>]*)>/i, `<svg viewBox="0 0 ${w} ${h}" $1>`);
    }
  }

  // 3. Defense-in-depth safety: remove <script>...</script> and on* attributes
  result = result
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  return result;
}

/**
 * Validates XML/SVG syntax in the browser environment.
 */
export function validateSvgSyntax(svgText: string): { valid: boolean; error?: string } {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return { valid: true };
  }
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgText, "image/svg+xml");
    const errorNode = doc.querySelector("parsererror");
    if (errorNode) {
      return {
        valid: false,
        error: errorNode.textContent?.trim() || "SVG XML 格式解析失败",
      };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

/**
 * Creates a Blob URL for an SVG string. Remember to revoke it when unmounting!
 */
export function createSvgBlobUrl(svgText: string): string {
  const normalized = normalizeSvg(svgText);
  const blob = new Blob([normalized], { type: "image/svg+xml;charset=utf-8" });
  return URL.createObjectURL(blob);
}

/**
 * Triggers a client-side download of the SVG file.
 */
export function downloadSvgFile(svgText: string, filename = "diagram.svg") {
  const normalized = normalizeSvg(svgText);
  const blob = new Blob([normalized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".svg") ? filename : `${filename}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * SVG 文本 → data: URL。比 blob: URL 省掉 revoke 生命周期（组件卸载 / 缓存复用时
 * 不会出现图被提前回收成裂图），卡片图导出也不用再转一道。
 */
export function svgToDataUrl(svgText: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

/** 读 SVG 根节点的固有尺寸：优先数字 width/height，其次 viewBox；都没有返回 null。 */
export function readSvgSize(svgText: string): { width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svgText);
  if (!open) return null;
  const tag = open[0];
  const num = (attr: string) => {
    const m = new RegExp(`\\s${attr}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`, "i").exec(tag);
    return m ? Number(m[1]) : NaN;
  };
  const w = num("width");
  const h = num("height");
  if (w > 0 && h > 0) return { width: w, height: h };
  const vb = /\sviewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']/i.exec(tag);
  if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) {
    const vw = Number(vb[1]);
    const vh = Number(vb[2]);
    // 只给了一边（如 width="800"）时按 viewBox 比例补另一边
    if (w > 0) return { width: w, height: (w * vh) / vw };
    if (h > 0) return { width: (h * vw) / vh, height: h };
    return { width: vw, height: vh };
  }
  return null;
}

/**
 * 宽进严出：按 HTML 宽松解析、再按 XML 严格序列化。
 * <img> / data: URL 里的 SVG 必须是良构 XML，而 HTML 序列化的产物（mermaid strict
 * 模式过 DOMPurify 后的 innerHTML）里 `<br>` 不闭合、模型手写的 SVG 常带裸 `&`、
 * `&nbsp;`——任何一处都会让整张图裂掉。仅浏览器端生效，服务端原样返回。
 */
export function toWellFormedSvg(svg: string): string {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return svg;
  const el = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  return el ? new XMLSerializer().serializeToString(el) : svg;
}
