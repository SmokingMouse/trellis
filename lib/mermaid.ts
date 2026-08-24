// Utilities for asynchronous Mermaid diagram parsing and SVG rendering.

let mermaidInstance: typeof import("mermaid").default | null = null;
let renderCounter = 0;

/**
 * Checks whether a language string indicates Mermaid code.
 */
export function isMermaidLang(lang?: string): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase().trim();
  return l === "mermaid" || l === "language-mermaid";
}

/**
 * Checks whether a code block represents a Mermaid diagram.
 */
export function isMermaidCode(code: string, lang?: string): boolean {
  if (isMermaidLang(lang)) return true;
  if (!lang || lang === "code" || lang === "text") {
    const trimmed = code.trim();
    // Common Mermaid diagram starters
    const starters = [
      /^graph\s+(?:TD|TB|BT|RL|LR)\b/i,
      /^flowchart\s+(?:TD|TB|BT|RL|LR)\b/i,
      /^sequenceDiagram\b/i,
      /^classDiagram\b/i,
      /^stateDiagram(?:-v2)?\b/i,
      /^erDiagram\b/i,
      /^gantt\b/i,
      /^pie\b/i,
      /^gitGraph\b/i,
      /^mindmap\b/i,
      /^timeline\b/i,
      /^quadrantChart\b/i,
      /^sankey(?:-beta)?\b/i,
      /^block(?:-beta)?\b/i,
      /^xychart(?:-beta)?\b/i,
      /^packet(?:-beta)?\b/i,
      /^kanban\b/i,
      /^architecture(?:-beta)?\b/i,
    ];
    return starters.some((re) => re.test(trimmed));
  }
  return false;
}

/**
 * Lazily loads and initializes the Mermaid library in client-side environment.
 */
async function getMermaid(isDark = false) {
  if (!mermaidInstance) {
    const m = await import("mermaid");
    mermaidInstance = m.default;
  }
  mermaidInstance.initialize({
    startOnLoad: false,
    theme: isDark ? "dark" : "default",
    securityLevel: "loose",
    suppressErrorRendering: true,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif',
  });
  return mermaidInstance;
}

/**
 * Renders Mermaid diagram source code into an SVG string.
 */
export async function renderMermaidToSvg(
  code: string,
  isDark = false,
): Promise<{ svg: string | null; error: string | null }> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { svg: null, error: "Mermaid 代码为空" };
  }

  if (typeof window === "undefined") {
    return { svg: null, error: "Mermaid 只能在客户端渲染" };
  }

  try {
    const mermaid = await getMermaid(isDark);
    const id = `mermaid-svg-${Date.now().toString(36)}-${++renderCounter}`;

    // Validate syntax first
    try {
      await mermaid.parse(trimmed, { suppressErrors: false });
    } catch (parseErr: unknown) {
      return {
        svg: null,
        error: (parseErr as Error)?.message || "Mermaid 语法未完成或有误",
      };
    }

    const { svg } = await mermaid.render(id, trimmed);
    return { svg, error: null };
  } catch (err: unknown) {
    return {
      svg: null,
      error: (err as Error)?.message || "Mermaid 渲染失败",
    };
  }
}
