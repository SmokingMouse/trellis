// 守卫：components / app / lib / hooks 里的颜色 utility 必须指向本项目注册过的颜色。
//
// 背景（S172）：写 `border-border` / `text-muted` 这类 shadcn 味的类名，Tailwind v4
// 不会报错、只是静默不生成 CSS——边框回落 currentColor 变黑框、文字不变灰。
// 本项目的颜色全部在 app/globals.css 的 @theme inline 里注册（line* / ink* /
// surface* / accent* …），还把 stone / indigo / amber / rose / emerald / fuchsia
// 六套默认调色板 reset 成 initial。这条测试把「类名 → 注册表」的对照做成静态扫描。
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["app", "components", "lib", "hooks"];
const PALETTE = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "fuchsia", "pink", "rose", "slate", "gray", "zinc", "neutral", "stone",
];
const SPECIAL = new Set(["white", "black", "transparent", "current", "inherit"]);
const TEXT_SIZE_DEFAULT = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]);
const TEXT_MISC = /^(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;
const BG_MISC = /^(none|cover|contain|auto|fixed|local|scroll|center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right|repeat|no-repeat|repeat-[xy]|repeat-round|repeat-space|clip-.*|origin-.*|gradient-to-.*|linear-.*|radial-.*|conic-.*|size-.*|position-.*|blend-.*)$/;
const BORDER_MISC = /^(\d+|box|solid|dashed|dotted|double|hidden|none|collapse|separate|spacing-.*)$/;
const BORDER_SIDE = /^([tblrxyse])(?:-(.+))?$/;
const DIVIDE_MISC = /^([xy](?:-(?:\d+|reverse))?|solid|dashed|dotted|double|hidden|none)$/;

export type Theme = { colors: Set<string>; resets: Set<string>; text: Set<string> };

export function readTheme(css: string): Theme {
  const start = css.indexOf("@theme inline");
  if (start < 0) throw new Error("app/globals.css: @theme inline block not found");
  const theme = css.slice(start);
  const colors = new Set<string>(), resets = new Set<string>(), text = new Set<string>();
  for (const m of theme.matchAll(/--color-([a-z0-9-]+?)(-\*)?\s*:\s*([^;]+);/g)) {
    if (m[2]) resets.add(m[1]);
    else if (m[3].trim() !== "initial") colors.add(m[1]);
  }
  for (const m of theme.matchAll(/--text-([a-z0-9]+)\s*:/g)) text.add(m[1]);
  return { colors, resets, text };
}

function isColor(token: string, theme: Theme) {
  if (SPECIAL.has(token) || theme.colors.has(token)) return true;
  const m = token.match(/^([a-z]+)-(50|[1-9]00|950)$/);
  return !!m && PALETTE.includes(m[1]) && !theme.resets.has(m[1]);
}

/** 返回 null = 合法（颜色已注册，或根本不是颜色类）；否则返回问题描述。 */
export function classify(prefix: string, rawToken: string, theme: Theme): string | null {
  const token = rawToken.replace(/\/\d+$/, "");
  if (token.startsWith("[") || token.endsWith("-")) return null;
  const need = (color: string) => isColor(color, theme) ? null
    : theme.resets.has(color.replace(/-(50|[1-9]00|950)$/, "")) ? `${prefix}-${rawToken}：调色板已在 @theme 里 reset`
    : `${prefix}-${rawToken}：颜色「${color}」未在 app/globals.css @theme 注册`;
  switch (prefix) {
    case "text":
      if (theme.text.has(token) || TEXT_SIZE_DEFAULT.has(token) || TEXT_MISC.test(token)) return null;
      return need(token);
    case "bg":
      if (BG_MISC.test(token)) return null;
      return need(token);
    case "border": {
      if (BORDER_MISC.test(token)) return null;
      const side = token.match(BORDER_SIDE);
      if (side) {
        if (!side[2] || /^\d+$/.test(side[2])) return null;
        return need(side[2]);
      }
      return need(token);
    }
    case "divide":
      if (DIVIDE_MISC.test(token)) return null;
      return need(token);
    default:
      return null;
  }
}

const CANDIDATE = /(?<![\w\-/.@#$])(text|bg|border|divide)-([a-z][a-z0-9-]*(?:\/\d+)?)(?![\w\-/])/g;

export function scanSource(source: string, theme: Theme): { line: number; problem: string }[] {
  const out: { line: number; problem: string }[] = [];
  const lines = source.split("\n");
  lines.forEach((raw, i) => {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("{/*")) return;
    const line = raw.replace(/\/\/.*$/, "").replace(/\[[^\]]*\]/g, "[]");
    for (const m of line.matchAll(CANDIDATE)) {
      const problem = classify(m[1], m[2], theme);
      if (problem) out.push({ line: i + 1, problem });
    }
  });
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.[jt]sx?$|\.d\.ts$/.test(entry)) yield path;
  }
}

describe("tailwind color guard", () => {
  const theme = readTheme(readFileSync(join(ROOT, "app/globals.css"), "utf8"));

  test("theme registry parsed", () => {
    expect(theme.colors.has("ink-muted")).toBe(true);
    expect(theme.colors.has("line")).toBe(true);
    expect(theme.text.has("ui")).toBe(true);
    expect(theme.resets.size).toBeGreaterThan(0);
  });

  test("catches shadcn-style names and reset palettes, passes registered ones", () => {
    expect(classify("border", "border", theme)).not.toBeNull();
    expect(classify("text", "muted", theme)).not.toBeNull();
    expect(classify("bg", "background", theme)).not.toBeNull();
    expect(classify("text", "muted-foreground", theme)).not.toBeNull();
    for (const reset of theme.resets) expect(classify("text", `${reset}-600`, theme)).toContain("reset");
    expect(classify("border", "line", theme)).toBeNull();
    expect(classify("text", "ink-muted/60", theme)).toBeNull();
    expect(classify("border", "t-warn", theme)).toBeNull();
    expect(classify("border", "b-0", theme)).toBeNull();
    expect(classify("divide", "line/70", theme)).toBeNull();
    expect(classify("text", "ui", theme)).toBeNull();
    expect(classify("text", "[16px]", theme)).toBeNull();
    expect(classify("bg", "gradient-to-br", theme)).toBeNull();
    expect(classify("bg", "surface-muted/60", theme)).toBeNull();
  });

  test("no unregistered color utilities in app / components / lib / hooks", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const hit of scanSource(readFileSync(file, "utf8"), theme)) {
          offenders.push(`${relative(ROOT, file)}:${hit.line} ${hit.problem}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
