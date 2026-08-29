import "server-only";
import fs from "node:fs";
import path from "node:path";
import { appRoot } from "./skills";

// 平台 pack：trellis 内置技能的 claude plugin dir，默认挂到每一个**有工具能力**
// 的 claude 系 spawn 上（enhanced chat / project，含自定义 agent —— pluginDirs
// 是数组，与 agent pack 并存）。对标 Herdr：跑在 pane 里的 agent 天然有 herdr
// CLI；跑在 Trellis 里的 agent 天然会操作 Trellis，不需要用户先建 agent、配技能。
//
// 形态是 **repo 内静态结构**，不做运行时物化（v1 曾物化到
// ~/.trellis/platform-pack，与 agent-pack 同套内容寻址 —— 但那套机制解决的是
// 「每 agent 一份、内容会变」的问题，平台 pack 全局一份、结构恒定，物化纯属
// 多余的一层）：
//
//   platform-plugin/
//     .claude-plugin/plugin.json   （name: "trellis" → 技能列出为 trellis:<dir>）
//     skills -> ../skills          （整目录相对 symlink：新增内置技能零维护）
//
// symlink 随 `git archive`（deploy.ts）与 Docker `COPY . .`（tenancy 镜像）
// 原样保留；prod 下经 appRoot() 的 `current` 软链引用，release 清理不悬空。
//
// 与 agent-pack 的分工：agent-pack 物化「某个自定义 Agent 的人设 + 选配技能」
// （每 agent 每内容一个目录，仍需物化）；这里只是「平台自身能力面」的静态指针。

/** 平台 pack 的 plugin dir。返回 null = 本次 spawn 不挂（被闸关掉 / 结构不在 /
 * 没有任何内置技能）—— 内置技能挂不上绝不能拦住 spawn 本身。
 *
 * TRELLIS_BUILTIN_SKILLS=off 是部署冒烟闸（与 TRELLIS_LARK=off 同款）：怀疑
 * 内置技能把会话搞坏时，一个 env 就能整体摘除。 */
export function platformPackDir(): string | null {
  if (process.env.TRELLIS_BUILTIN_SKILLS === "off") return null;
  const dir = path.join(appRoot(), "platform-plugin");
  try {
    if (!fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) return null;
    const skillsDir = path.join(dir, "skills");
    // 至少一个真实技能才挂 —— 空 plugin 没意义，结构残缺（symlink 悬空等）
    // 不该传给 CLI。readdirSync 跟随 symlink，悬空时直接走 catch。
    const hasSkill = fs
      .readdirSync(skillsDir)
      .some((n) => fs.existsSync(path.join(skillsDir, n, "SKILL.md")));
    return hasSkill ? dir : null;
  } catch {
    return null;
  }
}
