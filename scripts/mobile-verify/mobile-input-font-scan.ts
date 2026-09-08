import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["app", "components"];
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);
const excludedInputTypes = new Set(["checkbox", "radio", "range", "file", "hidden"]);

// Entries must be `path:line` and explain why the control cannot receive text focus.
const allowlist = new Map<string, string>([]);

type Finding = {
  location: string;
  reason: string;
  snippet: string;
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    return sourceExtensions.has(extension) ? [path] : [];
  });
}

function inputType(tag: string): string | null {
  const match = tag.match(/\btype\s*=\s*(?:["']([^"']+)["']|\{\s*["']([^"']+)["']\s*\})/i);
  return (match?.[1] ?? match?.[2] ?? null)?.toLowerCase() ?? null;
}

function smallOverrides(tag: string): string[] {
  const reasons: string[] = [];
  const importantNamed = /(?:^|[\s:])(?:!text-(?:nano|label|ui|xs|body|sm|reading)|text-(?:nano|label|ui|xs|body|sm|reading)!)(?=\s|["'`}])/g;
  if (importantNamed.test(tag)) reasons.push("important Tailwind text utility below 16px");

  const importantArbitrary = /(?:!text-\[|text-\[)(\d+(?:\.\d+)?)(px|rem|em)\](?:!)?/g;
  for (const match of tag.matchAll(importantArbitrary)) {
    const token = match[0];
    const pixels = Number(match[1]) * (match[2] === "px" ? 1 : 16);
    if ((token.startsWith("!") || token.endsWith("!")) && pixels < 16) {
      reasons.push(`important Tailwind arbitrary font ${match[1]}${match[2]}`);
    }
  }

  const importantProperty = /(?:!\[font-size:|\[font-size:)(\d+(?:\.\d+)?)(px|rem|em)\](?:!)?/g;
  for (const match of tag.matchAll(importantProperty)) {
    const token = match[0];
    const pixels = Number(match[1]) * (match[2] === "px" ? 1 : 16);
    if ((token.startsWith("!") || token.endsWith("!")) && pixels < 16) {
      reasons.push(`important Tailwind font-size property ${match[1]}${match[2]}`);
    }
  }

  const reactFontSize = /\bfontSize\s*:\s*(?:["']\s*)?(\d+(?:\.\d+)?)(px|rem|em)?/g;
  for (const match of tag.matchAll(reactFontSize)) {
    const pixels = Number(match[1]) * (match[2] && match[2] !== "px" ? 16 : 1);
    if (pixels < 16) reasons.push(`inline fontSize ${match[1]}${match[2] ?? "px"}`);
  }

  const cssFontSize = /\bfont-size\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)/gi;
  for (const match of tag.matchAll(cssFontSize)) {
    const pixels = Number(match[1]) * (match[2].toLowerCase() === "px" ? 1 : 16);
    if (pixels < 16) reasons.push(`inline font-size ${match[1]}${match[2]}`);
  }

  // `style={someVar}` hides the font-size behind a variable the regexes above
  // can't see through; flag for manual confirmation instead of silently passing.
  const styleIndirection = /\bstyle\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
  for (const match of tag.matchAll(styleIndirection)) {
    reasons.push(`style passed via variable, cannot statically verify font-size: style={${match[1]}}`);
  }

  return [...new Set(reasons)];
}

// The mobile fallback in app/globals.css only wins because it is the last
// input/textarea/select font-size rule in source order. If someone appends a
// smaller-font rule after it, this cheap check catches the regression even
// though this script never scans CSS files.
function checkGlobalsCssFallbackIsLast(cwd: string): string | null {
  const cssPath = join(cwd, "app", "globals.css");
  const source = readFileSync(cssPath, "utf8");
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let last: { line: number; selector: string; declaration: string } | null = null;
  for (const match of source.matchAll(rulePattern)) {
    const [, selectorRaw, body] = match;
    const selector = selectorRaw.trim();
    if (!/\b(input|textarea|select)\b/i.test(selector)) continue;
    const fontSizeMatch = body.match(/font-size\s*:\s*[^;]+;?/i);
    if (!fontSizeMatch) continue;
    const line = source.slice(0, match.index).split("\n").length;
    last = { line, selector, declaration: fontSizeMatch[0].trim().replace(/;$/, "") };
  }
  if (!last) return "app/globals.css: no input/textarea/select font-size rule found";
  const isKnownFallback =
    /\binput\b/i.test(last.selector) &&
    /\btextarea\b/i.test(last.selector) &&
    /\bselect\b/i.test(last.selector) &&
    /^font-size\s*:\s*16px$/i.test(last.declaration);
  if (!isKnownFallback) {
    return `app/globals.css:${last.line}: last input/textarea/select font-size rule is not the mobile 16px fallback (selector="${last.selector.replace(/\s+/g, " ")}", declaration="${last.declaration}") — a later rule may override it`;
  }
  return null;
}

const findings: Finding[] = [];
let scanned = 0;
const usedAllowlist = new Set<string>();

for (const file of roots.flatMap(sourceFiles)) {
  const source = readFileSync(file, "utf8");
  const tagPattern = /<(input|textarea)\b[\s\S]*?(?:\/>|<\/textarea\s*>)/gi;
  for (const match of source.matchAll(tagPattern)) {
    const [, kind] = match;
    const tag = match[0];
    if (kind.toLowerCase() === "input") {
      const type = inputType(tag);
      if (type && excludedInputTypes.has(type)) continue;
    }

    scanned += 1;
    const line = source.slice(0, match.index).split("\n").length;
    const location = `${relative(process.cwd(), file)}:${line}`;
    for (const reason of smallOverrides(tag)) {
      const exception = allowlist.get(location);
      if (exception) {
        usedAllowlist.add(location);
        continue;
      }
      findings.push({
        location,
        reason,
        snippet: tag.replace(/\s+/g, " ").slice(0, 180),
      });
    }
  }
}

const staleAllowlist = [...allowlist.entries()].filter(([location]) => !usedAllowlist.has(location));
if (staleAllowlist.length > 0) {
  console.error("Stale mobile input font allowlist entries:");
  for (const [location, reason] of staleAllowlist) console.error(`- ${location}: ${reason}`);
  process.exit(1);
}

if (findings.length > 0) {
  console.error("Text controls with explicit small-font overrides that escape the global mobile guard:");
  for (const finding of findings) {
    console.error(`- ${finding.location}: ${finding.reason}\n  ${finding.snippet}`);
  }
  process.exit(1);
}

const cssFallbackError = checkGlobalsCssFallbackIsLast(process.cwd());
if (cssFallbackError) {
  console.error("Mobile font-size fallback in app/globals.css is no longer authoritative:");
  console.error(`- ${cssFallbackError}`);
  process.exit(1);
}

console.log(`mobile input font scan passed: ${scanned} text controls, 0 escaping overrides; globals.css fallback still last`);
