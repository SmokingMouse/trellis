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
