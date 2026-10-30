import "server-only";
import type { AgentRecord } from "./agents";
import { ensureRoleDir, roleSpawnExtras, roleWorkspacePath } from "./roles";
import type { AgentSpawn } from "@/lib/llm/types";
import { resolveAgentSpawn } from "./agent-pack";

// 角色 P2（docs/roles-p2.md C「注入」）：定时任务、飞书会话的 agent 是角色时，和角色会话
// 一样挂角色目录（--add-dir）+ 追加记忆说明（--append-system-prompt / codex 接在人设后）。
//
// cwd 规则同角色会话，但只在「mode 允许」时生效：
//   · 任务 / 机器人自己配了工作目录 → 用它（那是用户为这件事选的目录，角色目录 --add-dir 挂上）；
//   · project 模式没配目录 → 用角色的 work_dir，没有就角色目录本身（同 roleWorkspacePath）；
//   · chat 模式（增强档，cwd = chat-scratch）→ 不改 cwd，角色目录照样 --add-dir 挂上
//     （增强 chat 有 workspace，additionalWorkspaces 生效）。

/** 叠上角色增量；非角色 / 记忆关掉 / 没有 base spawn → 原样返回。 */
export function withRoleSpawn(
  record: AgentRecord | null,
  base: AgentSpawn | null,
  cwd: string | null,
): AgentSpawn | null {
  if (!record || !base) return base;
  const extras = roleSpawnExtras(record, cwd);
  return extras ? { ...base, ...extras } : base;
}

/** tasks / 飞书共用：resolveAgentSpawn + 角色增量。mock 不吃人设 → null；@外援那一轮
 * （mention）只要人设、不挂记忆（与 chat 路由同：外援的人设与记忆不进主线）。 */
export function resolveRoleAwareSpawn(
  record: AgentRecord | null,
  family: string,
  workspacePath: string | null,
  cwd: string | null,
  opts: { mention?: boolean } = {},
): AgentSpawn | null {
  if (!record || (family !== "claude" && family !== "codex")) return null;
  const base = resolveAgentSpawn(record, family, workspacePath);
  return opts.mention ? base : withRoleSpawn(record, base, cwd);
}

/** 角色在 project 模式下、调用方没给目录时的工作目录；其余情况原样返回 workspacePath。 */
export function roleDefaultWorkspace(
  record: AgentRecord | null,
  mode: string,
  workspacePath: string | null,
): string | null {
  if (workspacePath || mode !== "project" || !record || record.kind !== "role") return workspacePath;
  ensureRoleDir(record.slug); // 落到角色目录时它得先存在（launch 会先验目录）
  return roleWorkspacePath(record);
}
