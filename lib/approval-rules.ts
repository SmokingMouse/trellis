// 工具审批的三档作用域（参考 Codex 手机端：仅本次 / 本会话 / 所有会话）。
//
// 这里只放纯逻辑（客户端 + 服务端共用、bun test 覆盖）：
//   - 作用域解析：respond 请求体里的 scope（兼容旧客户端的 alwaysAllowTool）
//   - 规则键：一次待审批交互 → 「要放行的规则」（粒度 = 工具名）
//   - 规则文本：UI 上告诉用户点下去会放行什么
//   - 匹配：会话规则优先于全局规则
// 存储与 DB 读写在 lib/server/approval-rules.ts。

export type ApprovalScope = "once" | "session" | "global";
export type RuleScope = Exclude<ApprovalScope, "once">;

export const APPROVAL_SCOPES: readonly ApprovalScope[] = ["once", "session", "global"];

export type ApprovalRule = {
  id: string;
  scope: RuleScope;
  /** scope=session 时是 trellis 会话 id；global 为 null。 */
  sessionId: string | null;
  /** 规则键，见 approvalToolKey。 */
  toolKey: string;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
};

/** 写进 ToolCall 的「已按规则自动允许」痕迹（nodes.tool_calls_json 里随调用持久化）。 */
export type ToolCallApproval = {
  by: "rule";
  scope: RuleScope;
  ruleId: string;
  toolKey: string;
  at: number;
};

// 永远要人答的交互：问答与计划审批不是「权限」，不能被规则放行。
const NEVER_RULED = new Set(["AskUserQuestion", "ExitPlanMode"]);

// 文件修改归成一个键：agent-server 路径把 Write/Edit/MultiEdit/NotebookEdit 统一投影成
// fileChange 审批（toolName="Edit"），codex 也只报 "Edit"。legacy claude 路径能看到原名，
// 但同一条规则在两条路径上语义必须一致，所以统一折成 "Edit" = 「文件修改」。
const FILE_CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * 解析 respond 请求体里的作用域。非法值按「仅本次」处理（最保守）。
 * 旧客户端只会发 alwaysAllowTool:true —— 它原本的语义是「本轮内同名工具不再弹卡」，
 * 最接近的新档是「本会话」。
 */
export function parseApprovalScope(body: { scope?: unknown; alwaysAllowTool?: unknown }): ApprovalScope {
  if (typeof body.scope === "string" && (APPROVAL_SCOPES as readonly string[]).includes(body.scope)) {
    return body.scope as ApprovalScope;
  }
  return body.alwaysAllowTool === true ? "session" : "once";
}

/**
 * 一次待审批交互对应的规则键；null = 这类交互不允许建规则（只能逐次答）。
 * agent-server 的通用权限请求（toolName="Permission"）把真实工具名放在
 * input.permissions.toolName（MCP 工具等），按真实名建键。
 */
export function approvalToolKey(interaction: { toolName: string; input?: unknown }): string | null {
  let name = interaction.toolName;
  if (name === "Permission") {
    const permissions = (interaction.input as { permissions?: { toolName?: unknown } } | null)?.permissions;
    if (typeof permissions?.toolName === "string" && permissions.toolName) name = permissions.toolName;
  }
  if (!name || NEVER_RULED.has(name)) return null;
  return FILE_CHANGE_TOOLS.has(name) ? "Edit" : name;
}

/** 规则放行范围的人话（UI 上「将放行：…」那一行与设置页列表共用）。 */
export function describeToolKey(toolKey: string): string {
  if (toolKey === "Bash") return "Bash：任意 shell 命令";
  if (toolKey === "Edit") return "文件修改：Write / Edit / MultiEdit / NotebookEdit";
  if (toolKey === "Permission") return "其它权限请求（未标明工具）";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolKey);
  if (mcp) return `MCP ${mcp[1]} · ${mcp[2]}`;
  return `${toolKey}：该工具的所有调用`;
}

/** 审批卡主按钮文案（随作用域变）。 */
export function allowLabel(scope: ApprovalScope): string {
  return scope === "once" ? "允许一次" : scope === "session" ? "本会话始终允许" : "所有会话始终允许";
}

export function scopeLabel(scope: ApprovalScope): string {
  return scope === "once" ? "仅本次" : scope === "session" ? "本会话" : "所有会话";
}

/**
 * 在规则表里找能放行这次调用的那条。会话规则优先（更窄、更贴近用户此刻的意图），
 * 其次全局。别的会话的会话规则永远不命中。
 */
export function matchApprovalRule(
  rules: readonly ApprovalRule[],
  query: { sessionId: string; toolKey: string | null },
): ApprovalRule | null {
  if (!query.toolKey) return null;
  let global: ApprovalRule | null = null;
  for (const rule of rules) {
    if (rule.toolKey !== query.toolKey) continue;
    if (rule.scope === "session" && rule.sessionId === query.sessionId) return rule;
    if (rule.scope === "global" && !global) global = rule;
  }
  return global;
}
