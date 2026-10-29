// 统一 diff（`git diff` 输出）→ 文件 / hunk / 行结构。纯函数，客户端审阅层
// （WorkspaceDiffModal）与 bun test 共用。
//
// 解析策略：按 `diff --git` 切文件；hunk 内按 @@ 头里的行数计数消费，计数
// 用完即视为 hunk 结束——这样「被截断的尾巴」「hunk 后的杂项行」都不会被误认
// 成上下文行，空行（有些工具会吃掉上下文行开头的空格）也能正确归为上下文。

export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  /** 去掉 +/-/空格 前缀后的正文；meta 行（\ No newline…）保留原文 */
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export type DiffHunk = {
  header: string;
  /** @@ … @@ 之后的函数 / 段落提示（可能为空） */
  section: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFileStatus = "M" | "A" | "D" | "R";

export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// git 对含特殊字符的路径会加双引号并做 C 风格转义（core.quotepath=false 时
// 中文不再转义，但 tab / 引号 / 反斜杠仍会）。
export function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (!(s.startsWith('"') && s.endsWith('"') && s.length >= 2)) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
      continue;
    }
    const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };
    bytes.push(...enc.encode(map[next] ?? next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(p: string): string | null {
  const s = unquoteGitPath(p);
  if (s === "/dev/null") return null;
  return s.replace(/^[ab]\//, "");
}

// `diff --git a/x b/x`：路径含空格时无法可靠切分；只在两边同名时（最常见的
// 模式变更 / 二进制无 ---/+++ 行的情况）用对称切分兜底。
function pathsFromGitLine(line: string): { a: string | null; b: string | null } {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+(.*)$/);
    if (m) return { a: stripPrefix(m[1]), b: stripPrefix(m[2]) };
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.replace(/^a\//, "") === b.replace(/^b\//, "")) {
      return { a: stripPrefix(a), b: stripPrefix(b) };
    }
  }
  const sp = rest.indexOf(" b/");
  if (sp > 0) return { a: stripPrefix(rest.slice(0, sp)), b: stripPrefix(rest.slice(sp + 1)) };
  return { a: null, b: null };
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text) return files;
  const lines = text.split("\n");

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let minusPath: string | null | undefined;
  let plusPath: string | null | undefined;

  const finishFile = () => {
    if (!file) return;
    if (plusPath !== undefined || minusPath !== undefined) {
      if (plusPath === null && minusPath) {
        file.status = "D";
        file.path = minusPath;
      } else if (minusPath === null && plusPath) {
        file.status = "A";
        file.path = plusPath;
      } else if (plusPath) {
        file.path = plusPath;
        if (file.status === "R" && !file.oldPath && minusPath) file.oldPath = minusPath;
      }
    }
    if (file.path) files.push(file);
    file = null;
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      const { a, b } = pathsFromGitLine(line);
      file = { path: b ?? a ?? "", oldPath: null, status: "M", binary: false, additions: 0, deletions: 0, hunks: [] };
      minusPath = undefined;
      plusPath = undefined;
      continue;
    }
    if (!file) continue;

    // hunk 正文：计数没用完之前，一切都按 +/-/上下文消费
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === "+") {
        hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
        newLeft--;
        file.additions++;
        continue;
      }
      if (c === "-") {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
        oldLeft--;
        file.deletions++;
        continue;
      }
      if (c === "\\") {
        hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
        continue;
      }
      if (c === " " || line === "") {
        hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      // 计数与正文对不上（被截断 / 非标准输出）：结束 hunk，往下按头部解析
      hunk = null;
    }
    if (hunk && line.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }

    const m = line.match(HUNK_RE);
    if (m) {
      const oldStart = parseInt(m[1], 10);
      const oldLines = m[2] === undefined ? 1 : parseInt(m[2], 10);
      const newStart = parseInt(m[3], 10);
      const newLines = m[4] === undefined ? 1 : parseInt(m[4], 10);
      hunk = { header: line, section: m[5].trim(), oldStart, oldLines, newStart, newLines, lines: [] };
      file.hunks.push(hunk);
      oldLeft = oldLines;
      newLeft = newLines;
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }
    if (line.startsWith("--- ")) {
      minusPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      plusPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("new file mode")) file.status = "A";
    else if (line.startsWith("deleted file mode")) file.status = "D";
    else if (line.startsWith("rename from ")) {
      file.status = "R";
      file.oldPath = unquoteGitPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.status = "R";
      file.path = unquoteGitPath(line.slice("rename to ".length));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }
  finishFile();
  return files;
}

/** 文件按所在目录分组（目录按字典序，根目录排最前）；组内保持原顺序。 */
export function groupFilesByDir<T extends { path: string }>(files: T[]): { dir: string; files: T[] }[] {
  const map = new Map<string, T[]>();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i >= 0 ? f.path.slice(0, i) : "";
    const arr = map.get(dir);
    if (arr) arr.push(f);
    else map.set(dir, [f]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, fs]) => ({ dir, files: fs }));
}

export function fileBaseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
