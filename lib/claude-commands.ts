// Herdr 输入框的斜杠补全：Claude Code 自己的命令（不是 Trellis 的 lib/commands.ts）。
// 选中后原样作为文本发进窗格，由 Claude Code 执行 —— 这里只负责「有哪些」与匹配。
//
// 内置命令是常量表（常用子集，Claude Code 没有可读的清单）；用户 skills / commands 由
// /api/herdr/commands 在服务端扫目录列出（lib/server/claude-commands.ts）。

export type ClaudeSlashKind = "builtin" | "skill" | "command";

export type ClaudeSlashCommand = {
  name: string;
  description: string;
  kind: ClaudeSlashKind;
};

export const CLAUDE_BUILTIN_COMMANDS: ClaudeSlashCommand[] = [
  { name: "compact", description: "压缩对话上下文（可附带保留重点的说明）", kind: "builtin" },
  { name: "clear", description: "清空对话历史，开始新对话", kind: "builtin" },
  { name: "model", description: "切换或查看当前模型", kind: "builtin" },
  { name: "cost", description: "本会话的 token 用量与花费", kind: "builtin" },
  { name: "context", description: "查看上下文窗口占用", kind: "builtin" },
  { name: "review", description: "审查代码改动 / PR", kind: "builtin" },
  { name: "init", description: "为项目生成 CLAUDE.md", kind: "builtin" },
  { name: "resume", description: "恢复之前的会话", kind: "builtin" },
  { name: "memory", description: "编辑记忆文件（CLAUDE.md）", kind: "builtin" },
  { name: "config", description: "打开设置", kind: "builtin" },
  { name: "permissions", description: "查看 / 修改工具权限", kind: "builtin" },
  { name: "mcp", description: "管理 MCP 服务器", kind: "builtin" },
  { name: "agents", description: "管理子 agent", kind: "builtin" },
  { name: "hooks", description: "管理 hooks 配置", kind: "builtin" },
  { name: "status", description: "查看版本、模型、账号与连接状态", kind: "builtin" },
  { name: "doctor", description: "诊断安装与配置问题", kind: "builtin" },
  { name: "help", description: "帮助与命令列表", kind: "builtin" },
];

export const CLAUDE_SLASH_KIND_LABEL: Record<ClaudeSlashKind, string> = {
  builtin: "内置命令",
  skill: "技能",
  command: "自定义命令",
};

/** 合并内置 + 发现的命令：同名以内置为准（Claude Code 自己也是内置优先），按出现顺序去重。 */
export function mergeClaudeCommands(discovered: ClaudeSlashCommand[]): ClaudeSlashCommand[] {
  const seen = new Set<string>();
  const out: ClaudeSlashCommand[] = [];
  for (const command of [...CLAUDE_BUILTIN_COMMANDS, ...discovered]) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    out.push(command);
  }
  return out;
}

/**
 * 输入以 `/` 开头且还没打空格时，按名字匹配：前缀命中排前、包含命中其后；各组内保持原序。
 * 其它情况（普通文字、已经在写参数）返回 []，补全面板不出现。
 */
export function matchClaudeCommands(
  text: string,
  commands: ClaudeSlashCommand[],
  limit = 8,
): ClaudeSlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const q = text.slice(1).toLowerCase();
  const prefix: ClaudeSlashCommand[] = [];
  const contains: ClaudeSlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (name.includes(q)) contains.push(command);
  }
  return [...prefix, ...contains].slice(0, limit);
}
