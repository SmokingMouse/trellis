import "server-only";
import { randomUUID } from "node:crypto";
import { getDB } from "./sqlite";
import { dbWrite } from "./db-error";
import {
  approvalToolKey,
  matchApprovalRule,
  type ApprovalRule,
  type ApprovalScope,
  type RuleScope,
  type ToolCallApproval,
} from "@/lib/approval-rules";

// 审批规则的存储层（approval_rules 表，迁移见 sqlite.ts）。
//
// 两条运行路径共用：legacy run-bus（onCanUseTool 回调）与 agent-server thread
// （ProjectRun 收到 requestApproval）。两边都是「发起审批前先 findApprovalRule，命中就
// 自动放行 + 在对应 ToolCall 上留 approval 痕迹」，没命中才弹卡。

type Row = {
  id: string;
  scope: RuleScope;
  session_id: string | null;
  tool_key: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
};

const toRule = (r: Row): ApprovalRule => ({
  id: r.id,
  scope: r.scope,
  sessionId: r.session_id,
  toolKey: r.tool_key,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
});

export type ApprovalRuleListItem = ApprovalRule & { sessionTitle: string | null };

/** 设置页列表：全部规则 + 会话标题（会话规则用来定位）。最近用过的在前。 */
export function listApprovalRules(): ApprovalRuleListItem[] {
  const rows = getDB()
    .prepare(
      `SELECT r.*, s.title AS session_title FROM approval_rules r
         LEFT JOIN sessions s ON s.id = r.session_id
        ORDER BY r.scope = 'session', COALESCE(r.last_used_at, r.created_at) DESC`,
    )
    .all() as (Row & { session_title: string | null })[];
  return rows.map((r) => ({ ...toRule(r), sessionTitle: r.session_title }));
}

/** 能作用于某会话的规则（该会话的会话规则 + 全部全局规则）。 */
export function rulesForSession(sessionId: string): ApprovalRule[] {
  const rows = getDB()
    .prepare("SELECT * FROM approval_rules WHERE scope = 'global' OR session_id = ?")
    .all(sessionId) as Row[];
  return rows.map(toRule);
}

/**
 * 用户在审批卡上选了「本会话 / 所有会话」后落一条规则。同键已存在就复用（幂等），
 * 「仅本次」不落库返回 null。拿不到规则键（问答 / 计划审批）也返回 null。
 */
export function grantApprovalRule(args: {
  scope: ApprovalScope;
  sessionId: string;
  interaction: { toolName: string; input?: unknown };
  now?: number;
}): ApprovalRule | null {
  if (args.scope === "once") return null;
  const toolKey = approvalToolKey(args.interaction);
  if (!toolKey) return null;
  const sessionId = args.scope === "session" ? args.sessionId : null;
  const db = getDB();
  dbWrite("grantApprovalRule", () =>
    db
      .prepare(
        `INSERT OR IGNORE INTO approval_rules (id, scope, session_id, tool_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), args.scope, sessionId, toolKey, args.now ?? Date.now()),
  );
  const row = db
    .prepare(
      "SELECT * FROM approval_rules WHERE scope = ? AND IFNULL(session_id, '') = ? AND tool_key = ?",
    )
    .get(args.scope, sessionId ?? "", toolKey) as Row | null;
  return row ? toRule(row) : null;
}

export function revokeApprovalRule(id: string): boolean {
  const res = dbWrite("revokeApprovalRule", () =>
    getDB().prepare("DELETE FROM approval_rules WHERE id = ?").run(id),
  );
  return res.changes > 0;
}

/**
 * 发起审批前的匹配。命中就记一次使用（use_count / last_used_at，设置页据此显示
 * 「最近用于」），并返回要写进 ToolCall 的痕迹。
 */
export function findApprovalRule(
  sessionId: string,
  interaction: { toolName: string; input?: unknown },
  now = Date.now(),
): { rule: ApprovalRule; approval: ToolCallApproval } | null {
  const toolKey = approvalToolKey(interaction);
  if (!toolKey) return null;
  const rule = matchApprovalRule(rulesForSession(sessionId), { sessionId, toolKey });
  if (!rule) return null;
  try {
    dbWrite("touchApprovalRule", () =>
      getDB()
        .prepare("UPDATE approval_rules SET use_count = use_count + 1, last_used_at = ? WHERE id = ?")
        .run(now, rule.id),
    );
  } catch {
    /* 统计是附带信息，写不进不影响放行 */
  }
  return {
    rule,
    approval: { by: "rule", scope: rule.scope, ruleId: rule.id, toolKey, at: now },
  };
}
