import "server-only";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigDiffItem, ImportResultItem, SkillFile, SkillPackItem } from "@/lib/config-sync";
import { parseFrontmatter } from "./skills";

// 配置同步 · 技能（~/.claude/skills/<name>/ 整目录）。
//
// 可移植单元 = 一个技能目录（SKILL.md + scripts / references 等）。只同步用户技能根：
// trellis 自带技能（<app>/skills）随部署走，每台机器本来就一样；~/.agents/skills 在本机
// 基本是指回 ~/.claude/skills 的软链，codex 侧的 $CODEX_HOME/skills 是 CLI 自带的系统技能。
//
// 不出机器的东西（导出时只报相对路径、不带内容；覆盖时目标自己的那份原样留下）：
//   - 敏感文件：.env*、私钥 / 证书、credentials / secrets / token(s) / cookies 文件、.netrc 等
//   - 依赖与缓存目录：.git、node_modules、.venv、__pycache__ 等（体积大、跟机器走）
//   - 数据库文件（*.db / *.sqlite）：多半是运行时缓存，可能存着登录态
//   - 目录内的软链（不跟随，免得把技能目录外的文件带出去）
//
// 写入防护：技能名与每个相对路径都过白名单校验，落盘前再断言解析后的绝对路径在暂存目录内；
// 先写到技能根旁边的暂存目录，整体就绪后 rename 换上，失败不留半个技能。

export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_BYTES = 8 * 1024 * 1024;
export const MAX_SKILL_FILES = 1000;

export function userSkillsRoot(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && !name.includes("..");
}

/** 相对路径白名单：posix、非绝对、无 . / .. / 空段、无反斜杠与控制字符。 */
export function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.length > 1024) return false;
  if (rel.startsWith("/") || rel.includes("\\") || /[\u0000-\u001f]/.test(rel)) return false;
  return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && seg.length <= 255);
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".secrets"]);
const SKIP_FILES = new Set([".DS_Store"]);

/** 敏感文件判据（按文件名）。导出时剔除、覆盖时保留目标自己的。 */
export function isSensitiveFile(basename: string): boolean {
  const b = basename.toLowerCase();
  if (/^\.env(\..+)?$/.test(b)) return !/\.(example|sample|template)$/.test(b);
  if (/\.(pem|key|p12|pfx|keystore|jks|crt|cer)$/.test(b)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(b)) return true;
  if (/^(credentials?|secrets?|tokens?|auth|cookies?|session)(\.(json|ya?ml|toml|txt|ini|env|cfg))?$/.test(b)) return true;
  if (/^\.(netrc|npmrc|pypirc|git-credentials)$/.test(b)) return true;
  if (/\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(b)) return true;
  return false;
}

type WalkResult = {
  files: { rel: string; abs: string; mode: number; size: number }[];
  /** 没带出的相对路径（敏感文件、依赖目录、软链） */
  excluded: string[];
  size: number;
  tooLarge: boolean;
};

/** 遍历技能目录（顶层软链跟随一次，目录内软链不跟随）。超限即停。 */
function walkSkill(dir: string): WalkResult {
  const out: WalkResult = { files: [], excluded: [], size: 0, tooLarge: false };
  const visit = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.tooLarge) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isSymbolicLink()) {
        out.excluded.push(childRel);
        continue;
      }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) out.excluded.push(`${childRel}/`);
        else visit(childAbs, childRel);
        continue;
      }
      if (!e.isFile() || SKIP_FILES.has(e.name)) continue;
      if (isSensitiveFile(e.name)) {
        out.excluded.push(childRel);
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.statSync(childAbs);
      } catch {
        continue;
      }
      out.size += st.size;
      out.files.push({ rel: childRel, abs: childAbs, mode: st.mode & 0o111 ? 0o755 : 0o644, size: st.size });
      if (st.size > MAX_SKILL_FILE_BYTES || out.size > MAX_SKILL_BYTES || out.files.length > MAX_SKILL_FILES) {
        out.tooLarge = true;
      }
    }
  };
  visit(dir, "");
  return out;
}

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/** 技能指纹：按路径排序的「路径 / 权限 / 内容哈希」清单再哈希。两边都排除同一批文件，可直接比。 */
export function skillHash(files: Pick<SkillFile, "path" | "mode" | "sha256">[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\u0000${f.mode.toString(8)}\u0000${f.sha256}`);
  return sha256(lines.join("\n"));
}

function readSkillItem(dir: string, name: string, withContent: boolean): SkillPackItem | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const { description } = parseFrontmatter(raw, name);
  const walked = walkSkill(dir);
  if (walked.tooLarge) {
    return { name, description, hash: "", size: walked.size, files: [], excluded: walked.excluded, tooLarge: true };
  }
  const files: SkillFile[] = [];
  for (const f of walked.files) {
    const buf = fs.readFileSync(f.abs);
    files.push({
      path: f.rel,
      mode: f.mode,
      size: buf.length,
      sha256: sha256(buf),
      ...(withContent ? { data: buf.toString("base64") } : {}),
    });
  }
  return { name, description, hash: skillHash(files), size: walked.size, files, excluded: walked.excluded };
}

/** 导出：技能根下每个含 SKILL.md 的目录。names 给定时只导这些。 */
export function exportSkills(
  root: string,
  opts: { names?: string[] | null; withContent: boolean },
): SkillPackItem[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const wanted = opts.names ? new Set(opts.names) : null;
  const items: SkillPackItem[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".") || !isValidSkillName(e.name)) continue;
    if (wanted && !wanted.has(e.name)) continue;
    const dir = path.join(root, e.name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const item = readSkillItem(dir, e.name, opts.withContent);
    if (item) items.push(item);
  }
  return items;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function summary(item: SkillPackItem): string {
  const parts = [`${item.files.length} 个文件 · ${fmtSize(item.size)}`];
  if (item.excluded.length) parts.push(`${item.excluded.length} 项不同步（敏感文件 / 依赖目录）`);
  return parts.join(" · ");
}

export function diffSkill(root: string, item: SkillPackItem): ConfigDiffItem {
  const base = { kind: "skills" as const, key: item.name, label: item.name, warnings: [] as string[] };
  if (item.tooLarge) {
    return { ...base, status: "blocked", reason: `超过单技能上限（${fmtSize(MAX_SKILL_BYTES)} / ${MAX_SKILL_FILES} 个文件 / 单文件 ${fmtSize(MAX_SKILL_FILE_BYTES)}）` };
  }
  const target = path.join(root, item.name);
  let lst: fs.Stats | null = null;
  try {
    lst = fs.lstatSync(target);
  } catch {
    /* 不存在 */
  }
  if (!lst) return { ...base, status: "new", summary: summary(item) };
  const existing = readSkillItem(target, item.name, false);
  if (existing && existing.hash === item.hash) return { ...base, status: "same", summary: summary(item) };
  if (lst.isSymbolicLink()) {
    return { ...base, status: "blocked", reason: "目标机器上这个技能是软链（由外部仓库管理），不覆盖" };
  }
  if (!existing) {
    return { ...base, status: "blocked", reason: "目标机器上同名路径不是技能目录（没有 SKILL.md），不覆盖" };
  }
  const theirs = new Map(existing.files.map((f) => [f.path, f]));
  const ours = new Map(item.files.map((f) => [f.path, f]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [p, f] of ours) {
    const t = theirs.get(p);
    if (!t) added++;
    else if (t.sha256 !== f.sha256 || t.mode !== f.mode) changed++;
  }
  for (const p of theirs.keys()) if (!ours.has(p)) removed++;
  const changes = [
    added && `新增 ${added} 个文件`,
    changed && `改动 ${changed} 个文件`,
    removed && `删除 ${removed} 个文件`,
  ].filter(Boolean) as string[];
  return { ...base, status: "conflict", summary: summary(item), changes };
}

/** 校验并解码一个技能包的全部文件；不合格直接抛（整个技能不写）。 */
function decodeFiles(item: SkillPackItem): { rel: string; mode: number; buf: Buffer }[] {
  if (item.files.length > MAX_SKILL_FILES) throw new Error("文件数超过上限");
  let total = 0;
  const seen = new Set<string>();
  const out: { rel: string; mode: number; buf: Buffer }[] = [];
  let hasSkillMd = false;
  for (const f of item.files) {
    if (!isSafeRelPath(f.path)) throw new Error(`非法路径：${f.path}`);
    if (seen.has(f.path)) throw new Error(`重复路径：${f.path}`);
    seen.add(f.path);
    if (typeof f.data !== "string") throw new Error("包里缺文件内容（需先取带内容的导出包）");
    const buf = Buffer.from(f.data, "base64");
    if (buf.length > MAX_SKILL_FILE_BYTES) throw new Error(`文件过大：${f.path}`);
    total += buf.length;
    if (total > MAX_SKILL_BYTES) throw new Error("技能总大小超过上限");
    if (sha256(buf) !== f.sha256) throw new Error(`内容校验失败：${f.path}`);
    if (f.path === "SKILL.md") hasSkillMd = true;
    out.push({ rel: f.path, mode: f.mode === 0o755 ? 0o755 : 0o644, buf });
  }
  if (!hasSkillMd) throw new Error("缺 SKILL.md");
  return out;
}

function within(base: string, abs: string): boolean {
  return abs.startsWith(base + path.sep);
}

/** 应用一个技能：create = 目标不存在；overwrite = 替换目标目录，但目标自己的敏感文件 / 依赖目录留下。 */
export function applySkill(
  root: string,
  item: SkillPackItem,
  action: "create" | "overwrite",
): Pick<ImportResultItem, "outcome" | "message" | "warnings"> {
  if (!isValidSkillName(item.name)) return { outcome: "failed", message: "非法技能名", warnings: [] };
  const files = decodeFiles(item);
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const target = path.join(rootReal, item.name);
  if (path.dirname(target) !== rootReal) return { outcome: "failed", message: "非法技能名", warnings: [] };

  // 暂存目录放在技能根旁边（同一文件系统才能 rename），不放进技能根里——放进去会被
  // scanSkillRoot 当成「点开头的分组层」扫到，半成品技能会短暂出现在列表里。
  const tmpBase = `${rootReal}.trellis-sync`;
  fs.mkdirSync(tmpBase, { recursive: true });
  const staging = path.join(tmpBase, `${item.name}-${randomUUID()}`);
  fs.mkdirSync(staging);
  const warnings: string[] = [];
  try {
    for (const f of files) {
      const dest = path.resolve(staging, f.rel);
      if (!within(staging, dest)) throw new Error(`路径越界：${f.rel}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.buf, { mode: f.mode });
      fs.chmodSync(dest, f.mode);
    }

    let exists = false;
    try {
      const lst = fs.lstatSync(target);
      if (lst.isSymbolicLink()) throw new Error("目标是软链，不覆盖");
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (exists && action === "create") throw new Error("目标已存在同名技能");

    if (exists) {
      // 目标自己的敏感文件、依赖目录（node_modules / .venv …）搬进新目录，不被来源覆盖掉。
      const kept = walkSkill(target).excluded.map((p) => p.replace(/\/$/, ""));
      for (const rel of kept) {
        const from = path.join(target, rel);
        const to = path.resolve(staging, rel);
        if (!within(staging, to) || fs.existsSync(to)) continue;
        try {
          if (fs.lstatSync(from).isSymbolicLink()) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.symlinkSync(fs.readlinkSync(from), to);
          } else {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
          }
        } catch {
          warnings.push(`未能保留 ${rel}`);
        }
      }
      if (kept.length) warnings.push(`保留了目标自己的 ${kept.length} 项（敏感文件 / 依赖目录）`);
      const trash = path.join(tmpBase, `.old-${item.name}-${randomUUID()}`);
      fs.renameSync(target, trash);
      fs.renameSync(staging, target);
      fs.rmSync(trash, { recursive: true, force: true });
    } else {
      fs.renameSync(staging, target);
    }
    if (item.excluded.length) {
      warnings.push(`来源有 ${item.excluded.length} 项未同步（敏感文件 / 依赖目录），如技能需要请在目标机器自行补齐`);
    }
    return { outcome: exists ? "overwritten" : "created", warnings };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.rmdirSync(tmpBase);
    } catch {
      /* 并发中的其它暂存还在 */
    }
  }
}
