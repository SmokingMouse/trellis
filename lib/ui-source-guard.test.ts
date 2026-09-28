// 守卫（W5）：组件 / app 源码里禁止三类写法——
//   ① hex 颜色字面量（#fff / #6366f1 …）：颜色一律走语义 utility / CSS 变量；
//   ② `active:scale-*`：克制工具风只用颜色反馈，不做按压缩放；
//   ③ 原生 `window.confirm(` / `window.alert(` / 裸 `alert(`：走 useConfirm / toast。
//
// 例外必须**显式标记**，不设隐式白名单：
//   - 行级：同一行或上方 3 行内写 `ui-guard-allow(<rule>): 理由`
//     （rule = hex / scale / native-dialog），JSX 里写成 {/* … */}。
//   - 文件级：文件里任意位置写 `ui-guard-allow-file(<rule>): 理由`。
//   - fixture 目录（__fixtures__ / fixtures）整个跳过。
// 注释内的文字不算违规（先剥掉注释再扫）。
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["app", "components", "lib", "hooks", "stores"];
const ALLOW_WINDOW = 3;

export type Rule = "hex" | "scale" | "native-dialog";

const RULES: { rule: Rule; re: RegExp; what: string }[] = [
  { rule: "hex", re: /(?<![\w&/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z-])/g, what: "hex 颜色字面量" },
  { rule: "scale", re: /\bactive:scale-/g, what: "active:scale-*" },
  { rule: "native-dialog", re: /(?:\b(?:window|globalThis)\.(?:confirm|alert)\(|(?<![\w.$])alert\()/g, what: "原生 confirm / alert" },
];

/** 剥注释：块注释替换成等量换行（保行号），行注释只认行首或空白后的 `//`（避开 https://）。 */
export function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlock
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

export function scanUiSource(source: string): { line: number; rule: Rule; text: string }[] {
  const rawLines = source.split("\n");
  const fileAllow = new Set<Rule>();
  for (const m of source.matchAll(/ui-guard-allow-file\(([a-z-]+)\)/g)) fileAllow.add(m[1] as Rule);
  const allowedAt = (i: number, rule: Rule) => {
    for (let j = Math.max(0, i - ALLOW_WINDOW); j <= i; j++) {
      if (rawLines[j].includes(`ui-guard-allow(${rule})`)) return true;
    }
    return false;
  };
  const out: { line: number; rule: Rule; text: string }[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      for (const { rule, re } of RULES) {
        if (fileAllow.has(rule)) continue;
        for (const m of line.matchAll(re)) {
          if (allowedAt(i, rule)) continue;
          out.push({ line: i + 1, rule, text: m[0] });
        }
      }
    });
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".") || /^_*fixtures_*$/.test(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.[jt]sx?$|\.d\.ts$/.test(entry)) yield path;
  }
}

describe("ui source guard", () => {
  test("规则自检：命中 / 放行 / 注释 / 标记", () => {
    expect(scanUiSource(`const c = "#6366f1";`).map((h) => h.rule)).toEqual(["hex"]);
    expect(scanUiSource(`cls("bg-[#fff]")`).map((h) => h.rule)).toEqual(["hex"]);
    expect(scanUiSource(`"a,#fff_0%"`).map((h) => h.rule)).toEqual(["hex"]);
    expect(scanUiSource(`<b className="active:scale-95" />`).map((h) => h.rule)).toEqual(["scale"]);
    expect(scanUiSource(`if (window.confirm("x")) go();`).map((h) => h.rule)).toEqual(["native-dialog"]);
    expect(scanUiSource(`alert("x")`).map((h) => h.rule)).toEqual(["native-dialog"]);
    // 不误伤
    expect(scanUiSource(`const ok = await confirm({ title: "删？" });`)).toEqual([]);
    expect(scanUiSource(`href="#section" id="#bad-anchor-x"`)).toEqual([]);
    expect(scanUiSource(`const u = "https://x.dev/#abc"; // #6366f1`)).toEqual([]);
    expect(scanUiSource(`/* 旧色 #6366f1 */ const a = 1;`)).toEqual([]);
    expect(scanUiSource(`PR #50 &#123;`)).toEqual([]);
    // 显式标记
    expect(scanUiSource(`// ui-guard-allow(hex): 品牌\nconst c = "#6366f1";`)).toEqual([]);
    expect(scanUiSource(`// ui-guard-allow(scale): x\nconst c = "#6366f1";`).length).toBe(1);
    expect(scanUiSource(`// ui-guard-allow-file(hex): swatch\n\n\n\n\nconst c = "#6366f1";`)).toEqual([]);
  });

  test("app / components / lib / hooks / stores 无未标记的 hex / active:scale / 原生对话框", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const hit of scanUiSource(readFileSync(file, "utf8"))) {
          offenders.push(`${relative(ROOT, file)}:${hit.line} [${hit.rule}] ${hit.text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
