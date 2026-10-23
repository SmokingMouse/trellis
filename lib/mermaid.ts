// Utilities for asynchronous Mermaid diagram parsing and SVG rendering.

import { toWellFormedSvg } from "./svg";

/**
 * Checks whether a language string indicates Mermaid code.
 */
export function isMermaidLang(lang?: string): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase().trim();
  return l === "mermaid" || l === "language-mermaid" || l === "mmd";
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
      /^journey\b/i,
      /^requirementDiagram\b/i,
      /^C4(?:Context|Container|Component|Dynamic|Deployment)\b/,
    ];
    return starters.some((re) => re.test(trimmed));
  }
  return false;
}

// --- LLM 方言归一化层 -------------------------------------------------------
// 大模型写 mermaid 有稳定的方言偏好，这里当成一等输入做常开归一化（渲染前恒先跑，
// 归一化版解析不过再回退原文）。规则全部保守：已合规的写法原样透传、幂等。
// 每条规则都对应 mermaid 11 解析器实测会报错的写法：
//   · 全部图表：HTML 注释 <!-- --> → %% 注释；识别图表类型时跳过 YAML frontmatter
//   · flowchart：label / 边文字 / subgraph 标题裸写 [] {} () | " → 包双引号
//     （中文节点 id 同样适用）；小写 end 当节点 id → End；行尾 %% 注释 → 去掉
//   · sequenceDiagram：消息 / Note 里的全角冒号 → 半角；正文里的 ; → #59;

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

const isQuoted = (text: string) => /^"[\s\S]*"$/.test(text.trim());

// end 是 subgraph 的闭合关键字，小写 end 当节点 id 必报错；官方建议改大小写
const safeId = (id: string) => (id === "end" ? "End" : id);

// 一段最多含一个节点定义（段以边操作符切开），用贪婪的 lastIndexOf 找闭合符，
// 这样 label 内部的同类括号（`[L_i ... L_{i+k}]`）不会被误认为提前闭合。
// id 允许中文等任意非定界字符；@ 留给 v11 的 `A@{ shape: … }` 新语法，不碰。
function normalizeSegment(seg: string): string {
  const m = seg.match(/^(\s*)([^\s[\](){}<>|"@&]+)([\s\S]*?)(\s*)$/);
  if (!m) return seg;
  const [, lead, rawId, rest, tail] = m;
  const id = safeId(rawId);
  for (const [open, close] of NODE_SHAPES) {
    if (!rest.startsWith(open)) continue;
    const end = rest.lastIndexOf(close);
    if (end < open.length) break; // 未闭合（可能仍在流式输出中），label 不动
    const label = rest.slice(open.length, end);
    if (isQuoted(label) || !RISKY_LABEL_CHARS.test(label)) break;
    const after = rest.slice(end + close.length);
    return `${lead}${id}${open}${quoteLabel(label)}${close}${after}${tail}`;
  }
  return id === rawId ? seg : `${lead}${id}${rest}${tail}`;
}

// 边操作符：--> --- ==> -.-> 及两端标记 <--> x--x o--o --x --o，外加并联 &。
// 两端的 x / o 必须贴着空白（前标记之前、后标记之后），免得吃掉 Box-->B 的 x、--> oNode 的 o
const EDGE_AT = /(?:<|(?<=^|\s)[xo])?(?:-{2,}|={2,}|-\.+-)(?:>|[xo](?=\s|$|\|))?|&/y;

// 边文字 |…| 的闭合竖线：引号里的 | 是正文（`-->|"a|b"|`）
function closingPipe(line: string, from: number): number {
  let quoted = false;
  for (let j = from; j < line.length; j++) {
    if (line[j] === '"') quoted = !quoted;
    else if (line[j] === "|" && !quoted) return j;
  }
  return -1;
}

type Token = { text: string; edge: boolean };

// 按边切段，只在括号外、引号外切：label 里的 & / -- 不再被误切
function splitFlowchartLine(line: string): Token[] {
  const tokens: Token[] = [];
  let buf = "";
  let depth = 0;
  let quoted = false;
  const flush = () => {
    if (buf) tokens.push({ text: buf, edge: false });
    buf = "";
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && "[({".includes(ch)) depth++;
    else if (!quoted && "])}".includes(ch)) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0) {
      // 行尾 %% 注释：mermaid 只认整行注释，行尾的会报错
      if (line.startsWith("%%", i)) break;
      if (ch === "|") {
        const close = closingPipe(line, i + 1);
        if (close > i) {
          flush();
          const inner = line.slice(i + 1, close);
          const risky = !isQuoted(inner) && RISKY_LABEL_CHARS.test(inner);
          tokens.push({ text: risky ? `|${quoteLabel(inner)}|` : line.slice(i, close + 1), edge: true });
          i = close;
          continue;
        }
      }
      EDGE_AT.lastIndex = i;
      const edge = EDGE_AT.exec(line);
      if (edge) {
        flush();
        tokens.push({ text: edge[0], edge: true });
        i += edge[0].length - 1;
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return tokens;
}

function normalizeSubgraphLine(line: string): string {
  // subgraph id[标题] / subgraph id [标题]
  const bracket = /^(\s*subgraph\s+[^\s[]+\s*\[)([\s\S]*)(\]\s*)$/.exec(line);
  if (bracket) {
    const [, head, title, tail] = bracket;
    return isQuoted(title) || !RISKY_LABEL_CHARS.test(title) ? line : `${head}${quoteLabel(title)}${tail}`;
  }
  // subgraph 一整串标题（可含空格）
  const plain = /^(\s*subgraph\s+)(.*?)(\s*)$/.exec(line);
  if (plain && plain[2] && !isQuoted(plain[2]) && RISKY_LABEL_CHARS.test(plain[2])) {
    return `${plain[1]}${quoteLabel(plain[2])}${plain[3]}`;
  }
  return line;
}

const FLOW_SKIP_LINE = /^\s*(flowchart\b|graph\b|end\s*$|classDef\b|linkStyle\b|direction\b|%%)/;

function normalizeFlowchartLine(line: string): string {
  if (FLOW_SKIP_LINE.test(line)) return line;
  // subgraph 的闭合 end 带行尾注释：只去注释，关键字原样保留
  if (/^\s*end\s*%%/.test(line)) return line.replace(/\s*%%.*$/, "");
  if (/^\s*subgraph\b/.test(line)) return normalizeSubgraphLine(line);
  // style / click / class 指令里引用的节点 id 跟着改名
  if (/^\s*(style|click)\s/.test(line)) return line.replace(/^(\s*(?:style|click)\s+)end\b/, "$1End");
  if (/^\s*class\s/.test(line)) {
    // class a,b 样式名：id 列表逗号后带空格也认
    return line.replace(/^(\s*class\s+)(.+?)(\s+\S+\s*)$/, (_, head: string, ids: string, tail: string) =>
      head + ids.split(",").map((id) => id.replace(/^(\s*)end(\s*)$/, "$1End$2")).join(",") + tail,
    );
  }
  return splitFlowchartLine(line)
    .map((t) => (t.edge ? t.text : normalizeSegment(t.text)))
    .join("");
}

// 时序图消息箭头：->> -->> -> --> -x --x -) --) 以及双向 <<->>
const SEQ_ARROW = /(?:<<)?-{1,2}(?:>>|>|x|\))/;
const SEQ_KEYWORD =
  /^\s*(participant|actor|loop|alt|else|opt|par|and|rect|critical|break|end|autonumber|activate|deactivate|box|create|destroy|title|links?|properties|details)\b/i;

function normalizeSequenceLine(line: string): string {
  const isNote = /^\s*note\b/i.test(line);
  if (!isNote && (SEQ_KEYWORD.test(line) || !SEQ_ARROW.test(line))) return line;
  let out = line;
  // 中文输入法下的全角冒号：只换「第一个」且出现在半角冒号之前的那个分隔符
  const wide = out.indexOf("：");
  const ascii = out.indexOf(":");
  if (wide >= 0 && (ascii < 0 || wide < ascii)) {
    out = `${out.slice(0, wide).trimEnd()}: ${out.slice(wide + 1).trimStart()}`;
  }
  const colon = out.indexOf(":");
  if (colon < 0 || !out.includes(";", colon)) return out;
  // 消息正文里的 ; 会被当成语句分隔；已经是实体（#59; / &amp; …）的不动
  const text = out
    .slice(colon + 1)
    .replace(/(#\d+|#[a-z]+|&#?\w+)?;/gi, (whole, entity?: string) => (entity ? whole : "#59;"));
  return out.slice(0, colon + 1) + text;
}

// <!-- --> 不是 mermaid 语法（只认 %%）。整行注释换成 %%（保住行号，报错行号对得上原文），
// 行内的直接去掉。引号 / 括号里的 <!-- 是 label 正文，不算注释。
function htmlCommentStart(line: string, from: number): number {
  let quoted = false;
  let depth = 0;
  for (let j = from; j < line.length; j++) {
    const c = line[j];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if ("[({".includes(c)) depth++;
    else if ("])}".includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && line.startsWith("<!--", j)) return j;
  }
  return -1;
}

function stripHtmlComments(code: string): string {
  if (!code.includes("<!--")) return code;
  let inComment = false;
  return code
    .split("\n")
    .map((line) => {
      let kept = "";
      let touched = inComment;
      let i = 0;
      while (i < line.length) {
        if (inComment) {
          const close = line.indexOf("-->", i);
          if (close < 0) break;
          inComment = false;
          i = close + 3;
        } else {
          const open = htmlCommentStart(line, i);
          if (open < 0) {
            kept += line.slice(i);
            break;
          }
          kept += line.slice(i, open);
          touched = true;
          inComment = true;
          i = open + 4;
        }
      }
      if (!touched) return line;
      return kept.trim() ? kept : "%%";
    })
    .join("\n");
}

// 图表声明行：跳过 YAML frontmatter（--- … ---）、%% 注释 / %%{init}%% 指令与空行
function declarationIndex(lines: string[]): number {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() === "---") {
    let close = i + 1;
    while (close < lines.length && lines[close].trim() !== "---") close++;
    if (close >= lines.length) return -1;
    i = close + 1;
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith("%%")) return i;
  }
  return -1;
}

/**
 * Normalizes LLM-dialect Mermaid into standard Mermaid (see the rule list
 * above). Returns the input untouched when nothing applies.
 */
export function normalizeMermaidSource(code: string): string {
  const src = stripHtmlComments(code);
  const lines = src.split("\n");
  const head = declarationIndex(lines);
  if (head < 0) return src;
  const kind = lines[head].trim();
  const lineFn = /^(flowchart|graph)\b/i.test(kind)
    ? normalizeFlowchartLine
    : /^sequenceDiagram\b/.test(kind)
      ? normalizeSequenceLine
      : null;
  if (!lineFn) return src;
  return lines.map((line, i) => (i > head ? lineFn(line) : line)).join("\n");
}

// --- 渲染管线 ---------------------------------------------------------------
// 唯一渲染入口：CodeBlock / FilePreview / HoverPreview 都走 renderMermaid。
// - 串行队列：initialize（切主题）+ parse + render 作为一个原子任务排队，不会出现
//   A 按暗色排进 mermaid 内部队列、B 先把全局配置改成亮色的竞态。
// - 结果缓存（源码 × 主题，LRU）：流式结束后卡片重挂载、切会话回来、全屏查看
//   都直接命中，不再闪「渲染中」；同一份源码并发请求共用一个 in-flight Promise。
// - securityLevel strict：label 里的 HTML 照常经 DOMPurify 清洗，并额外去 script、
//   禁用 click 回调——全屏查看器会把 SVG 直接内联进页面（要 DOM 才能搜索 /
//   清晰缩放），不能再靠 <img> 隔离兜底。

export type MermaidResult =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; error: string; detail?: string };

type MermaidApi = typeof import("mermaid").default;

const CACHE_CAP = 64;
const settled = new Map<string, MermaidResult>();
const inflight = new Map<string, Promise<MermaidResult>>();
let queue: Promise<unknown> = Promise.resolve();
let mermaidLoad: Promise<MermaidApi> | null = null;
let configuredDark: boolean | null = null;
let renderSeq = 0;

function cacheKey(code: string, dark: boolean): string {
  return `${dark ? "d" : "l"}:${code.trim()}`;
}

/** 同步查缓存：组件挂载时用它决定首帧直接出图还是先占位。 */
export function peekMermaid(code: string, dark: boolean): MermaidResult | undefined {
  const key = cacheKey(code, dark);
  const hit = settled.get(key);
  if (hit) {
    settled.delete(key);
    settled.set(key, hit);
  }
  return hit;
}

/** 渲染 Mermaid 源码为 SVG。永不 reject：失败以 { ok: false } 返回。 */
export function renderMermaid(code: string, dark: boolean): Promise<MermaidResult> {
  const hit = peekMermaid(code, dark);
  if (hit) return Promise.resolve(hit);
  const key = cacheKey(code, dark);
  const running = inflight.get(key);
  if (running) return running;

  const job = queue
    .then(() => renderNow(code.trim(), dark))
    .catch((err: unknown) => ({
      result: { ok: false as const, ...describeMermaidError(err) },
      cacheable: false,
    }))
    .then(({ result, cacheable }) => {
      inflight.delete(key);
      if (cacheable) {
        settled.set(key, result);
        if (settled.size > CACHE_CAP) {
          const oldest = settled.keys().next().value;
          if (oldest !== undefined) settled.delete(oldest);
        }
      }
      return result;
    });
  queue = job;
  inflight.set(key, job);
  return job;
}

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoad) {
    mermaidLoad = import("mermaid").then((m) => m.default);
    // chunk 加载失败（断网 / 部署切换）不要把失败永久缓存住
    mermaidLoad.catch(() => {
      mermaidLoad = null;
    });
  }
  return mermaidLoad;
}

function configure(mermaid: MermaidApi, dark: boolean) {
  if (configuredDark === dark) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? "dark" : "default",
    securityLevel: "strict",
    suppressErrorRendering: true,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif',
  });
  configuredDark = dark;
}

async function renderNow(
  source: string,
  dark: boolean,
): Promise<{ result: MermaidResult; cacheable: boolean }> {
  if (!source) return { result: { ok: false, error: "Mermaid 代码为空" }, cacheable: true };
  if (typeof window === "undefined") {
    return { result: { ok: false, error: "Mermaid 只能在客户端渲染" }, cacheable: false };
  }

  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid();
  } catch (err) {
    return {
      result: { ok: false, error: "Mermaid 渲染引擎加载失败，刷新页面重试", detail: String(err) },
      cacheable: false,
    };
  }
  configure(mermaid, dark);

  // 常开归一化：LLM 方言先转标准 mermaid；归一化版不过再回退原文（安全网），
  // 两版都挂时留下原文的报错——用户看到的源码是原文，行号要对得上。
  const normalized = normalizeMermaidSource(source);
  const candidates = normalized === source ? [source] : [normalized, source];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      await mermaid.parse(candidate, { suppressErrors: false });
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      const { svg } = await mermaid.render(`trellis-mermaid-${++renderSeq}`, candidate);
      return { result: { ok: true, ...withIntrinsicSize(finalizeSvg(svg, dark)) }, cacheable: true };
    } catch (err) {
      lastError = err;
    }
  }
  return { result: { ok: false, ...describeMermaidError(lastError) }, cacheable: true };
}

/**
 * 出图后处理（需要浏览器 DOM）：把 SVG 挂进一个屏幕外容器，让它自带的 <style>
 * 生效后按「实际计算出来的颜色」修读者看得见的问题，再按 XML 序列化回字符串：
 * - 良构 XML：strict 模式过 DOMPurify 的产物是 HTML 序列化（<br> 不闭合），
 *   直接当 <img> / data: URL 会整张裂图。
 * - 暗色适配：模型写 style / classDef 几乎只按白底配色（fill:#e8f5e9 这类浅粉彩）。
 *   暗色主题下把这些浅底换成同色相的深色调——颜色分组的语义还在，连线和文字也看得见。
 * - 文字对比度：只写 fill 不写 color 时，浅底配主题浅字、深底配主题深字。
 *   对比度不足 3:1 的节点 / 分组标题文字翻成黑或白。
 */
function finalizeSvg(svg: string, dark: boolean): string {
  if (typeof document === "undefined") return toWellFormedSvg(svg);
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    const root = host.querySelector("svg");
    if (!root) return toWellFormedSvg(svg);
    try {
      // 个别图表类型不写 viewBox：按实际包围盒补上，后面才拿得到固有尺寸
      if (!root.getAttribute("viewBox")) {
        const box = root.getBBox();
        if (box.width > 0 && box.height > 0) {
          root.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
        }
      }
      if (dark) darkenLightFills(root);
      fixLabelContrast(root);
    } catch {
      // 颜色修正是锦上添花，失败也照常出图
    }
    return new XMLSerializer().serializeToString(root);
  } finally {
    host.remove();
  }
}

type Rgba = [number, number, number, number];

const LABEL_INK_DARK: Rgba = [24, 24, 27, 1];
const LABEL_INK_LIGHT: Rgba = [244, 244, 245, 1];

function parseRgb(css: string): Rgba | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(
    css.trim(),
  );
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

const cssRgb = ([r, g, b]: Rgba) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 保留色相、压低明度与饱和度：浅粉彩 → 暗色界面里的同色深底。 */
function darkTint([r, g, b, a]: Rgba, lightness: number): Rgba {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l0 = (max + min) / 2;
  const s0 = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1));
  const s = Math.min(s0, 0.45);
  const c = (1 - Math.abs(2 * lightness - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255, a];
}

// 节点 / 分组的底色形状：flowchart 等新渲染器统一挂 .label-container（可能是 <g> 包几条 path）
function shapesOf(group: Element): SVGElement[] {
  const direct = group.querySelector<SVGElement>(
    ":scope > .label-container, :scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > path",
  );
  if (!direct) return [];
  if (direct.tagName.toLowerCase() !== "g") return [direct];
  return Array.from(direct.querySelectorAll<SVGElement>("path, rect, polygon, circle, ellipse")).filter(
    (el) => getComputedStyle(el).fill !== "none",
  );
}

function fillOf(shapes: SVGElement[]): Rgba | null {
  for (const el of shapes) {
    const rgb = parseRgb(getComputedStyle(el).fill);
    if (rgb && rgb[3] >= 0.5) return rgb;
  }
  return null;
}

const NODE_GROUPS = "g.node, g.cluster";

function darkenLightFills(root: SVGSVGElement) {
  for (const group of root.querySelectorAll(NODE_GROUPS)) {
    const shapes = shapesOf(group);
    const fill = fillOf(shapes);
    if (!fill || luminance(fill) < 0.5) continue;
    // 分组底比节点再暗一档，节点浮在分组上仍有层次
    const tint = cssRgb(darkTint(fill, group.classList.contains("cluster") ? 0.14 : 0.22));
    for (const el of shapes) el.style.setProperty("fill", tint, "important");
  }
  // 时序图 `rect rgb(...)` 高亮区块：同理压暗，上面的消息文字才看得见
  for (const el of root.querySelectorAll<SVGElement>("rect.rect")) {
    const fill = parseRgb(getComputedStyle(el).fill);
    if (fill && fill[3] >= 0.5 && luminance(fill) >= 0.5) {
      el.style.setProperty("fill", cssRgb(darkTint(fill, 0.16)), "important");
    }
  }
}

function fixLabelContrast(root: SVGSVGElement) {
  for (const group of root.querySelectorAll(NODE_GROUPS)) {
    const fill = fillOf(shapesOf(group));
    if (!fill) continue;
    const ink = contrastRatio(fill, LABEL_INK_DARK) >= contrastRatio(fill, LABEL_INK_LIGHT) ? LABEL_INK_DARK : LABEL_INK_LIGHT;
    // HTML 标签（foreignObject 里的 span / p）看 color，SVG <text> 看 fill
    for (const label of group.querySelectorAll<HTMLElement | SVGElement>(".nodeLabel, .cluster-label span, text")) {
      const isText = label.tagName.toLowerCase() === "text";
      const current = parseRgb(isText ? getComputedStyle(label).fill : getComputedStyle(label).color);
      if (!current || contrastRatio(current, fill) >= 3) continue;
      const targets = [label, ...Array.from(label.querySelectorAll<HTMLElement | SVGElement>("*"))];
      for (const el of targets) {
        el.style.setProperty(isText || el.tagName.toLowerCase() === "tspan" ? "fill" : "color", cssRgb(ink), "important");
      }
    }
  }
}

/**
 * mermaid 默认 useMaxWidth：根 <svg> 写 width="100%" + style="max-width: Npx"、不写
 * height。当 <img> 用时没有固有尺寸——小图被拉满容器宽、大图被压进高度上限，
 * 字缩到看不清。这里按 viewBox 回填真实宽高，让浏览器拿到图的「原始大小」。
 */
export function withIntrinsicSize(svg: string): { svg: string; width: number; height: number } {
  const open = /^\s*<svg\b[^>]*>/.exec(svg);
  if (!open) return { svg, width: 0, height: 0 };
  const tag = open[0];
  const vb = /\sviewBox=["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']/.exec(tag);
  if (!vb) return { svg, width: 0, height: 0 };
  const width = Math.round(Number(vb[3]) * 100) / 100;
  const height = Math.round(Number(vb[4]) * 100) / 100;
  if (!(width > 0 && height > 0)) return { svg, width: 0, height: 0 };
  const fixed = tag
    .replace(/\s(?:width|height)="[^"]*"/g, "")
    .replace(/max-width:\s*[\d.]+px;?\s*/, "")
    .replace(/\sstyle="\s*"/, "")
    .replace(/^(\s*<svg\b)/, `$1 width="${width}" height="${height}"`);
  return { svg: fixed + svg.slice(open.index + tag.length), width, height };
}

/** mermaid 的报错是多行英文（jison / langium 两种格式），拆成「一句话标题 + 原文详情」。 */
export function describeMermaidError(err: unknown): { error: string; detail?: string } {
  const raw = (err instanceof Error ? err.message : err ? String(err) : "").trim();
  if (!raw) return { error: "Mermaid 渲染失败" };
  const line = /\bon line (\d+)/i.exec(raw)?.[1] ?? /\bline (\d+)/i.exec(raw)?.[1];
  let error: string;
  if (/No diagram type detected|UnknownDiagramError/i.test(raw)) {
    error = "无法识别图表类型：首行应是 flowchart / sequenceDiagram 等图表声明";
  } else if (/Lexical error/i.test(raw)) {
    error = line ? `第 ${line} 行有无法识别的字符` : "源码里有无法识别的字符";
  } else if (/Parse error|Parsing failed|Expecting/i.test(raw)) {
    error = line ? `第 ${line} 行附近语法错误` : "Mermaid 语法错误";
  } else {
    error = "Mermaid 渲染失败";
  }
  return { error, detail: raw };
}

/** 下载 / 导出用：始终按浅色主题出图，拿到别处（白底查看器、文档）也看得清。 */
export async function renderMermaidForExport(code: string): Promise<string | null> {
  const res = await renderMermaid(code, false);
  return res.ok ? res.svg : null;
}
