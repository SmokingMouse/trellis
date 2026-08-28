import "server-only";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { builtinSkillsRoot } from "./skills";

// 平台 pack：把 trellis 自带的内置技能（<app>/skills/*，目前是 trellis-admin）
// 物化成一个 claude plugin dir，默认挂到每一个**有工具能力**的 claude 系 spawn
// 上（enhanced chat / project，含自定义 agent —— pluginDirs 是数组，与 agent
// pack 并存）。对标 Herdr：跑在 pane 里的 agent 天然有 herdr CLI；跑在 Trellis
// 里的 agent 天然会操作 Trellis，不需要用户先建 agent、再配技能。
//
// 与 agent-pack 的分工：agent-pack 物化「某个自定义 Agent 的人设 + 选配技能」，
// 每 agent 每内容一个目录；这里物化「平台自身的能力面」，全局一份。物化手法
// （内容寻址 + tmp/rename 双写安全 + TTL sweep）与 agent-pack 同一套，理由见彼处。

const PACK_ROOT = path.join(os.homedir(), ".trellis", "platform-pack");
const SWEEP_TTL_MS = 24 * 60 * 60 * 1000;

/** 目录结构/生成逻辑版本。改了 writePack 产出必须 +1，否则旧 hash 命中缓存、
 * 新逻辑永不生效（agent-pack 踩过的同一个坑）。 */
const PACK_FORMAT = 1;

/** 内置技能根下含 SKILL.md 的目录名（即会进 pack 的技能）。 */
function listBuiltinSkillDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function writePack(dir: string, root: string, skillDirs: string[]): void {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        // 调用名前缀：技能列出来是 trellis:<目录名>（如 trellis:trellis-admin）。
        name: "trellis",
        description: "Trellis 平台内置技能（平台自感知与操作）",
        version: "0.0.0",
      },
      null,
      2,
    ),
  );
  const skillsDir = path.join(dir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const name of skillDirs) {
    // symlink 而非拷贝：技能正文改了自动跟随（prod 下 root 经 `current` 软链，
    // 升级后也自动跟到新 release），永远不需要因内容变化重物化。
    fs.symlinkSync(path.join(root, name), path.join(skillsDir, name), "dir");
  }
}

/** 平台 pack 的 plugin dir。没有可挂的东西（无内置技能 / 被闸关掉 / 物化失败）
 * 时返回 null —— 内置技能挂不上绝不能拦住 spawn 本身。
 *
 * TRELLIS_BUILTIN_SKILLS=off 是部署冒烟闸（与 TRELLIS_LARK=off 同款）：怀疑
 * 内置技能把会话搞坏时，一个 env 就能整体摘除。 */
export function platformPackDir(): string | null {
  if (process.env.TRELLIS_BUILTIN_SKILLS === "off") return null;
  const root = builtinSkillsRoot();
  const skillDirs = listBuiltinSkillDirs(root);
  if (skillDirs.length === 0) return null;

  // 指纹只计「哪些技能、从哪个根链接」——不计技能正文（symlink 自动跟随）。
  const hash = createHash("sha256")
    .update(JSON.stringify([PACK_FORMAT, root, skillDirs]))
    .digest("hex")
    .slice(0, 16);
  const finalDir = path.join(PACK_ROOT, hash);
  if (fs.existsSync(finalDir)) return finalDir;

  try {
    fs.mkdirSync(PACK_ROOT, { recursive: true });
    const tmpDir = path.join(
      PACK_ROOT,
      `.tmp-${hash}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      writePack(tmpDir, root, skillDirs);
      fs.renameSync(tmpDir, finalDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === "EEXIST" || code === "ENOTEMPTY") && fs.existsSync(finalDir)) {
        // 竞态：并发 spawn 里别人先建好了。清掉自己的半成品，用他的。
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return finalDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw e;
    }
    sweepPlatformPacks(hash);
    return finalDir;
  } catch (e) {
    console.error("[platform-pack] 物化失败，本次 spawn 不带内置技能：", e);
    return null;
  }
}

/** 清过期的旧 hash 目录。TTL 的唯一理由与 agent-pack 相同：长跑 run 可能还持有
 * 上一版 pack 的路径。best-effort，永不抛。 */
export function sweepPlatformPacks(keepHash: string, ttlMs = SWEEP_TTL_MS): void {
  try {
    const now = Date.now();
    for (const e of fs.readdirSync(PACK_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === keepHash) continue;
      const p = path.join(PACK_ROOT, e.name);
      try {
        if (now - fs.statSync(p).mtimeMs > ttlMs) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {
        /* 单个目录清不掉不影响其余 */
      }
    }
  } catch {
    /* 目录不存在 / 无权限 —— 清理失败绝不拦 spawn */
  }
}
