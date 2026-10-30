// 角色（role）的共享契约：前后端都能 import 的类型、常量与纯函数。
//
// 角色 = agents 表里 kind='role' 的一行，加三样东西：
//   1. 一条固定会话（agents.home_session_id → sessions.kind='role'，侧栏会话列表里看不到）
//   2. 一个角色目录 ~/.trellis/roles/<slug>/（USER.md、MEMORY.md、memories/*.md）
//   3. 头像（色相 + 一个字）与一句话介绍
// 交互原型见 docs/ui-redesign/mockups/09-roles.html，设计见 docs/roles-p1.md。

export type AgentKind = "agent" | "role";

/** 记忆类型，与 Claude Code auto-memory 的 frontmatter 一致。 */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 界面上的分组名（原型：关于你 / 偏好 / 项目 / 参考）。 */
export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: "关于你",
  feedback: "偏好",
  project: "项目",
  reference: "参考",
};

/** GET /api/roles 列表项、GET /api/roles/[id] 的形状。 */
export type Role = {
  id: string;
  slug: string;
  name: string;
  /** 一句话介绍（侧栏副标题、一览面板） */
  intro: string;
  /** 人设正文，就是 agents.system_prompt */
  systemPrompt: string;
  avatarHue: number;
  /** 头像上的字；空串时取 name 第一个字 */
  avatarGlyph: string;
  model: string | null;
  /** 默认工作目录；null = 用角色目录本身当 cwd */
  workDir: string | null;
  memoryEnabled: boolean;
  builtin: boolean;
  enabled: boolean;
  /** 角色目录绝对路径（前端用来认出「写记忆」的工具调用） */
  homeDir: string;
  /** 固定会话；还没聊过 = null */
  homeSessionId: string | null;
  memoryCount: number;
  /** 固定会话最近一次更新（ms），没聊过 = null */
  lastActiveAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** POST /api/roles 的 body；PATCH /api/roles/[id] 接受它的 Partial（slug 不可改）。 */
export type RoleInput = {
  name: string;
  /** 不给就由服务端从 name 生成（非 ASCII 名字回落成 role-<6位随机>） */
  slug?: string;
  intro?: string;
  systemPrompt?: string;
  avatarHue?: number;
  avatarGlyph?: string;
  model?: string | null;
  workDir?: string | null;
  memoryEnabled?: boolean;
};

/** 一条记忆：memories/<file>.md，frontmatter 里有 name / description / metadata.type。 */
export type RoleMemory = {
  /** 文件名（含 .md），也是记忆的 id */
  file: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** 文件 mtime（ms） */
  updatedAt: number;
};

/** GET /api/roles/[id]/memories */
export type RoleMemoryList = {
  memoryEnabled: boolean;
  /** USER.md 全文（没有文件 = ""） */
  userMd: string;
  memories: RoleMemory[];
};

/** POST /api/roles/[id]/open 的返回：前端拿到 sessionId 就 previewSession，null = 进草稿态。 */
export type RoleOpenResult = { sessionId: string | null };

export const ROLE_AVATAR_HUES = [35, 150, 200, 255, 300, 0] as const;

/** 头像上显示的字。 */
export function roleGlyph(role: Pick<Role, "avatarGlyph" | "name">): string {
  const g = role.avatarGlyph.trim();
  if (g) return Array.from(g)[0];
  const first = Array.from(role.name.trim())[0] ?? "?";
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

/** 头像的内联渐变（不走 hex，过 ui-source-guard）。 */
export function roleAvatarBackground(hue: number): string {
  const h = Number.isFinite(hue) ? Math.round(hue) : 254;
  return `linear-gradient(140deg, oklch(72% 0.13 ${h}), oklch(58% 0.15 ${h + 40}))`;
}

/** 工具调用的目标路径是不是这个角色的记忆文件（memories/ 下的 .md）。
 * 前端靠它在回复下面画「记下了…」行。 */
export function isRoleMemoryPath(homeDir: string, filePath: string): boolean {
  const base = homeDir.replace(/\/+$/, "") + "/memories/";
  return filePath.startsWith(base) && filePath.endsWith(".md") && !filePath.slice(base.length).includes("/");
}

/** 记忆文件路径 → 文件名。 */
export function memoryFileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}
