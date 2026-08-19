import "server-only";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { AgentRecord, SkillRef } from "./agents";
import type { AgentSpawn } from "@/lib/llm/types";
import { claudeSkillRoots, listSkills } from "./skills";

// 把 DB 里的 Agent 定义变成「claude CLI 能吃的东西」。
//
// 两个复杂度档次，按有没有技能自动选：
//   无技能 → --agents '<json>'    零 fs 操作、零并发问题、零清理
//   有技能 → --plugin-dir <pack>  内容寻址物化（下面这一整套）
//
// 内置的 5 个纯人设全在第一档，所以最常见的路径完全不碰文件系统。

const PACK_ROOT = path.join(os.homedir(), ".trellis", "agent-packs");
/** 旧 pack 的保留期。够长到不会删掉某个长跑 run 正在用的目录。 */
const SWEEP_TTL_MS = 24 * 60 * 60 * 1000;

/** 技能目录逐根解析：用户 `~/.claude/skills` 优先，其次 trellis 自带 `skills/`
 * （内置技能随部署走，`trellis-admin` 靠它在没有任何手工 symlink 的机器上可用）。 */
function resolveSkillDir(name: string): string | null {
  for (const root of claudeSkillRoots()) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** claude --agents 的 JSON value 形状（实测字段，2026-07-31 / CLI 2.1.207）。 */
type InlineAgentDef = {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
};

/** pack 目录结构 / 生成逻辑的版本号。**改了 writePack 的产出就要 +1** ——
 * 否则老 hash 命中缓存目录，新逻辑对存量 agent 永远不生效（本文件的 Skill
 * 自动补全就踩过一次：改了代码、pack 没重建、行为纹丝不动）。
 * v3：技能源从单根 ~/.claude/skills 改为多根（+ trellis 自带 skills/）——
 * 存量 pack 可能缺内置技能的 symlink，必须重物化。 */
const PACK_FORMAT = 3;

/** agent 实际拿到的工具白名单。
 *
 * 技能靠 `Skill` 工具调起（2026-07-31 实测）。配了技能却把 Skill 挡在白名单外，
 * 技能就是摆设，而且**静默** —— 模型看得见技能名、就是调不动，只会绕路自己硬写。
 * 这种配置没有任何合理用途，直接补上而不是留给用户去踩。
 *
 * 必须是**唯一**来源：`--tools`（本次 spawn 全局）和 pack 里 agents/<slug>.md 的
 * frontmatter（这个 agent 能用什么）两处都要用它，漏一处就以更严的那处为准。 */
function effectiveTools(a: AgentRecord): string[] | null {
  if (!a.tools) return null; // 不限制
  const needsSkill = a.skills.some((s) => s.kind === "host");
  return needsSkill && !a.tools.includes("Skill") ? [...a.tools, "Skill"] : a.tools;
}

/** 只把「影响产物」的字段计进指纹。
 *
 * 技能只算**名字列表**不算内容 —— pack 里放的是指向 ~/.claude/skills/<dir> 的
 * symlink（2026-07-31 实测可被 --plugin-dir 加载），所以改了 skill 正文自动跟随，
 * 永远不需要重物化。把正文纳入指纹反而会让每次编辑 skill 都产生一个新目录。
 *
 * enabled / sortOrder / builtin / 时间戳都不影响产物，刻意不计 —— 计了会让
 * 「调一下排序」白白重建一份 pack。 */
export function agentContentHash(a: AgentRecord): string {
  const material = JSON.stringify([
    PACK_FORMAT,
    a.slug,
    a.name,
    a.description,
    a.systemPrompt,
    a.model,
    effectiveTools(a),
    a.disallowedTools,
    a.skills.map(skillDirName).sort(),
    a.inheritEnv,
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** 技能在 pack 里的目录名。
 *
 * 实测：claude 加载 plugin skill 取的是**目录名**，不是 SKILL.md frontmatter 里的
 * `name`（symlink 名 linked-zebra 指向 xhs-cards，列出来是 trellis-pack:linked-zebra）。
 * 所以 SkillRef.name 存的必须是 ~/.claude/skills 下的目录名，/api/skills 因此补返 `dir`。 */
function skillDirName(s: SkillRef): string {
  return s.name;
}

/** 目录名安全校验：技能名会直接拼进路径，不能放行 .. 或分隔符。 */
function isSafeDirName(n: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(n) && n !== "." && n !== "..";
}

function writePack(dir: string, a: AgentRecord): void {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: `trellis-${a.slug}`,
        description: a.description || a.name,
        version: "0.0.0",
      },
      null,
      2,
    ),
  );

  // agents/<slug>.md：frontmatter + 正文 = system prompt。
  // 正文里不做任何模板替换 —— 用户写什么模型收到什么。
  const fm: string[] = ["---", `name: ${a.slug}`];
  fm.push(`description: ${JSON.stringify(a.description || a.name)}`);
  const tools = effectiveTools(a);
  if (tools) fm.push(`tools: ${tools.join(", ")}`);
  if (a.model) fm.push(`model: ${a.model}`);
  fm.push("---", "");
  fs.writeFileSync(
    path.join(dir, "agents", `${a.slug}.md`),
    fm.join("\n") + a.systemPrompt + "\n",
  );

  const skillsDir = path.join(dir, "skills");
  let linked = 0;
  for (const ref of a.skills) {
    if (ref.kind !== "host") continue; // inline 未实现，schema 位先留着
    const name = skillDirName(ref);
    if (!isSafeDirName(name)) {
      console.warn(`[agent-pack] 跳过非法技能名 ${JSON.stringify(name)}`);
      continue;
    }
    const src = resolveSkillDir(name);
    // 技能被用户删了就跳过，不让整个会话失败 —— agent 少个技能能跑，
    // 起不来就什么都做不了。
    if (!src) {
      console.warn(
        `[agent-pack] 技能 ${name} 在 ${claudeSkillRoots().join(" / ")} 下都不存在，跳过`,
      );
      continue;
    }
    if (linked === 0) fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(src, path.join(skillsDir, name), "dir");
    linked++;
  }
}

/** 物化成 plugin dir，返回路径。幂等：同 hash 命中已存在的目录直接复用。 */
function materialize(a: AgentRecord, hash: string): string {
  const finalDir = path.join(PACK_ROOT, a.id, hash);
  if (fs.existsSync(finalDir)) return finalDir;

  // 写临时目录 + 原子 rename。两个进程同时物化同一个 agent 时，后到的那个
  // rename 会撞 EEXIST/ENOTEMPTY —— 那说明别人已经建好了，直接用即可。
  // 这是标准的内容寻址双写安全模式，不需要锁。
  fs.mkdirSync(path.join(PACK_ROOT, a.id), { recursive: true });
  const tmpDir = path.join(
    PACK_ROOT,
    a.id,
    `.tmp-${hash}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    writePack(tmpDir, a);
    fs.renameSync(tmpDir, finalDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if ((code === "EEXIST" || code === "ENOTEMPTY") && fs.existsSync(finalDir)) {
      // 竞态：别人先建好了。清掉自己的半成品，用他的。
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return finalDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
  return finalDir;
}

/** 清掉同一 agent 下过期的旧 hash 目录。best-effort，永不抛。
 *
 * TTL 存在的唯一理由：一个长跑的 run 可能还在用上一版 pack（claude 进程持有那个
 * 路径）。24h 之后不可能还有 run 活着，删了安全。 */
export function sweepAgentPacks(
  agentId: string,
  keepHash: string,
  ttlMs = SWEEP_TTL_MS,
): void {
  try {
    const dir = path.join(PACK_ROOT, agentId);
    const now = Date.now();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === keepHash) continue;
      const p = path.join(dir, e.name);
      try {
        if (now - fs.statSync(p).mtimeMs > ttlMs) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {
        /* 单个目录清不掉不影响其余 */
      }
    }
  } catch {
    /* 目录不存在 / 无权限 —— 清理失败绝不该拦住 spawn */
  }
}

function codexAgentPrompt(a: AgentRecord): string {
  const sections = [a.systemPrompt.trim()];
  for (const ref of a.skills) {
    let body = "";
    let source = "inline";
    if (ref.kind === "inline") {
      body = ref.body;
    } else if (isSafeDirName(ref.name)) {
      const dir = resolveSkillDir(ref.name);
      if (!dir) continue;
      try {
        body = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
        source = dir;
      } catch {
        continue;
      }
    }
    if (!body.trim()) continue;
    sections.push(
      [
        `Selected skill: ${ref.name}`,
        `Source directory: ${source}`,
        "Follow these instructions when relevant. Resolve relative files against the source directory.",
        body.trim(),
      ].join("\n"),
    );
  }
  return sections.filter(Boolean).join("\n\n---\n\n");
}

export function resolveAgentSpawn(
  a: AgentRecord,
  family: "claude" | "codex" = "claude",
  workspace?: string | null,
): AgentSpawn {
  if (family === "codex") {
    return {
      runtime: "codex",
      slug: a.slug,
      inheritEnv: a.inheritEnv,
      model: a.model,
      permission: a.permission,
      systemPrompt: codexAgentPrompt(a),
      environmentSkillNames: a.inheritEnv
        ? undefined
        : listSkills("codex", workspace).map((skill) => skill.name),
    };
  }

  const common: AgentSpawn = {
    runtime: "claude",
    slug: a.slug,
    inheritEnv: a.inheritEnv,
    model: a.model,
    tools: a.tools,
    disallowedTools: a.disallowedTools,
    permission: a.permission,
    requireApproval: a.requireApproval,
  };

  const hostSkills = a.skills.filter((s) => s.kind === "host");
  if (hostSkills.length === 0) {
    const def: InlineAgentDef = {
      // description 不能为空：claude 用它做 agent 的自述。空串时兜个底。
      description: a.description || a.name,
      prompt: a.systemPrompt,
    };
    // tools 走 --agents JSON 还是走 --tools 是有区别的：前者是「这个 agent 能用
    // 什么」，后者是「这次 spawn 全局有什么」。两处都设，取交集，语义最紧。
    if (a.tools) def.tools = a.tools;
    if (a.model) def.model = a.model;
    return { ...common, agentsJson: JSON.stringify({ [a.slug]: def }) };
  }

  // 有技能 → 物化。失败就降级成纯人设跑 —— 半个功能远好过整个会话发不出消息。
  try {
    const hash = agentContentHash(a);
    const pluginDir = materialize(a, hash);
    sweepAgentPacks(a.id, hash);
    return { ...common, tools: effectiveTools(a), pluginDir };
  } catch (e) {
    console.error(`[agent-pack] 物化 ${a.slug} 失败，降级为纯人设：`, e);
    return {
      ...common,
      agentsJson: JSON.stringify({
        [a.slug]: {
          description: a.description || a.name,
          prompt: a.systemPrompt,
          ...(a.tools ? { tools: a.tools } : {}),
          ...(a.model ? { model: a.model } : {}),
        },
      }),
    };
  }
}
