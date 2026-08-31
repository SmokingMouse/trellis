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

// --- LLM 产出兼容层 ---------------------------------------------------------
// 大模型生成的 flowchart 常在节点 label 里裸写 [] {} () | 等符号（如
// `A{在 [L_i ... L_{i+k}] 中?}`），mermaid 会把它们解析成图形定义符号导致
// parse error。以下修复只在原文 parse 失败时启用：把含风险字符的 label 包进
// 双引号（引号内除 `"` 外任意字符合法），对已合法的图零影响。

// 节点形状定界符，长的在前保证最长匹配（`([` 必须先于 `(` 判断）
const NODE_SHAPES: Array<[string, string]> = [
  ["((", "))"],
  ["([", "])"],
  ["[[", "]]"],
  ["[(", ")]"],
  ["{{", "}}"],
  ["[/", "/]"],
  ["[\\", "\\]"],
  ["[", "]"],
  ["(", ")"],
  ["{", "}"],
  [">", "]"],
];

const RISKY_LABEL_CHARS = /[[\]{}()|"]/;

function quoteLabel(label: string): string {
  return `"${label.replace(/"/g, "#quot;")}"`;
}

// 一段最多含一个节点定义（段以边操作符切开），用贪婪的 lastIndexOf 找闭合符，
// 这样 label 内部的同类括号（`[L_i ... L_{i+k}]`）不会被误认为提前闭合。
function repairSegment(seg: string): string {
  const m = seg.match(/^(\s*)([A-Za-z0-9_.:-]+)([\s\S]*?)(\s*)$/);
  if (!m) return seg;
  const [, lead, id, rest, tail] = m;
  for (const [open, close] of NODE_SHAPES) {
    if (!rest.startsWith(open)) continue;
    const end = rest.lastIndexOf(close);
    if (end < open.length) return seg; // 未闭合（可能仍在流式输出中），不动
    const label = rest.slice(open.length, end);
    const after = rest.slice(end + close.length);
    const trimmed = label.trim();
    if (/^"[\s\S]*"$/.test(trimmed)) return seg; // 已加引号
    if (!RISKY_LABEL_CHARS.test(label)) return seg;
    return `${lead}${id}${open}${quoteLabel(label)}${close}${after}${tail}`;
  }
  return seg;
}

const SKIP_LINE =
  /^\s*(flowchart\b|graph\b|subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b|%%)/;
// 边操作符：--> --- ==> === -.-> --x --o 及并联 &；捕获组让分隔符保留在结果里
const EDGE_SPLIT =
  /(<?-{2,3}>?|<?={2,3}>?|-\.+->?|--\s?[xo](?=\s|$)|[xo]--|&|\|[^|]*\|)/;

function repairFlowchartLine(line: string): string {
  if (SKIP_LINE.test(line)) return line;
  // 先处理边 label：|text| 内含风险字符时加引号
  const withEdgeLabels = line.replace(/\|([^|"]+)\|/g, (whole, inner: string) =>
    RISKY_LABEL_CHARS.test(inner) ? `|${quoteLabel(inner)}|` : whole,
  );
  return withEdgeLabels.split(EDGE_SPLIT).map(repairSegment).join("");
}

/**
 * Best-effort repair for LLM-generated flowchart/graph source whose node or
 * edge labels contain unquoted special characters. Returns the input untouched
 * for non-flowchart diagrams.
 */
export function repairMermaidSource(code: string): string {
  const firstMeaningful =
    code
      .split("\n")
      .find((l) => l.trim() && !l.trim().startsWith("%%"))
      ?.trim() ?? "";
  if (!/^(flowchart|graph)\s/i.test(firstMeaningful)) return code;
  return code.split("\n").map(repairFlowchartLine).join("\n");
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

    // Validate syntax first; on failure, try the auto-repaired source once
    let source = trimmed;
    try {
      await mermaid.parse(source, { suppressErrors: false });
    } catch (parseErr: unknown) {
      const repaired = repairMermaidSource(trimmed);
      let recovered = false;
      if (repaired !== trimmed) {
        try {
          await mermaid.parse(repaired, { suppressErrors: false });
          source = repaired;
          recovered = true;
        } catch {
          // fall through to original error
        }
      }
      if (!recovered) {
        return {
          svg: null,
          error: (parseErr as Error)?.message || "Mermaid 语法未完成或有误",
        };
      }
    }

    const { svg } = await mermaid.render(id, source);
    return { svg, error: null };
  } catch (err: unknown) {
    return {
      svg: null,
      error: (err as Error)?.message || "Mermaid 渲染失败",
    };
  }
}
