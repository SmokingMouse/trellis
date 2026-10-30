// 阻塞交互（hook 挂住等 Trellis 作答）的纯逻辑：交互 id、种类判定、作答校验、
// 回给 Claude Code 的 hook stdout JSON。不碰 DB / 进程状态，单测直接穷举。
//
// 只有 trellis 拉起的会话会走到这里：它们启动时带 `--settings ~/.trellis/hooks/
// blocking-settings.json`，那份 settings 只给 PreToolUse(AskUserQuestion) 与
// PermissionRequest 挂上 `trellis-hook.sh --block`（见 ./blocking-settings.ts）。
//
// 返回 JSON 的形状以 Claude Code hooks 官方文档为准（code.claude.com/docs/en/hooks，
// 2.1.280 本机核对），ExitPlanMode 的「allow 必须带 updatedInput + setMode」是
// chyroc/jarvis 在 2.1.310 实测的结论，本仓库真机冒烟复核过（见报告）。
import { createHash } from "node:crypto";
import type { BlockingKind, BlockingSummary, InteractionResolution } from "@/lib/herdr-blocking";
import { approvalSummary } from "./normalize";
import type { ClaudeHookPayload } from "./types";

/** hook 一侧最长等多久（与脚本的 TRELLIS_HOOK_WAIT_MAX 默认值一致）。 */
export const INTERACTION_TTL_MS = 30 * 60_000;
/** hook 断开（没有轮询）后 server 保留交互多久，等它重连。 */
export const INTERACTION_DETACH_GRACE_MS = 3 * 60_000;
/** 单段长轮询的上限：脚本每段 25s，这里留一点余量防恶意超长 wait。 */
export const INTERACTION_MAX_WAIT_MS = 30_000;

export type { BlockingKind, BlockingSummary, InteractionResolution, PlanMode } from "@/lib/herdr-blocking";

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** 键排序后的 JSON：同一个对象不管键序如何都得到同一串（没有 tool_use_id 时的 id 依据）。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/**
 * 确定性交互 id：同一次工具调用不管 hook 重连几次、trellis 重启几次都算出同一个。
 *   session_id + 事件 + 工具名 + tool_use_id；
 *   没有 tool_use_id（PermissionRequest 的 stdin 就不带）→ 规范化后的 tool_input + hook 进程的 attempt。
 * attempt 是脚本进程启动时生成、每次重连原样带上的随机串：只按 input 算的话，同一会话里
 * 第二次跑一模一样的命令会撞上第一次的 id，直接拿走上一次的「允许」—— 必须隔开。
 */
export function interactionId(payload: ClaudeHookPayload, attempt: string | null = null): string {
  const toolUseId = str(payload.tool_use_id);
  const key = [
    str(payload.session_id) ?? "",
    str(payload.hook_event_name) ?? "",
    str(payload.tool_name) ?? "",
    toolUseId
      ? `id:${toolUseId}`
      : `input:${canonicalJson(payload.tool_input ?? null)}${attempt ? `\u0000attempt:${attempt}` : ""}`,
  ].join("\u0000");
  return `ix_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

/** 这条 hook 要不要挂住等 Trellis。null = 不阻塞，脚本立刻无输出退出（交给 TUI）。 */
export function blockingKind(payload: ClaudeHookPayload): BlockingKind | null {
  if (!str(payload.session_id)) return null;
  const event = str(payload.hook_event_name);
  const tool = str(payload.tool_name);
  if (!tool) return null;
  if (event === "PreToolUse") {
    return tool === "AskUserQuestion" && askQuestions(payload.tool_input).length > 0 ? "question" : null;
  }
  if (event === "PermissionRequest") {
    // AskUserQuestion 的答案只能经 PreToolUse 的 updatedInput 送进去；权限这一跳不管它，
    // 不然同一次提问会冒出两张卡。
    if (tool === "AskUserQuestion") return null;
    return tool === "ExitPlanMode" ? "plan" : "permission";
  }
  return null;
}

type AskQuestion = { question: string; multiSelect: boolean; options: string[] };

export function askQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== "object") return [];
  const list = (input as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return [];
  const out: AskQuestion[] = [];
  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    const text = str(r.question);
    if (!text) continue;
    const options = Array.isArray(r.options)
      ? r.options.map((o) => (o && typeof o === "object" ? str((o as Record<string, unknown>).label) : null)).filter((l): l is string => !!l)
      : [];
    out.push({ question: text, multiSelect: r.multiSelect === true, options });
  }
  return out;
}

function inputObject(payload: ClaudeHookPayload): Record<string, unknown> {
  const input = payload.tool_input;
  return input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
}

/** PermissionRequest 是否支持「本会话总是允许」（ExitPlanMode 不给）。 */
export function supportsAlways(payload: ClaudeHookPayload): boolean {
  return str(payload.hook_event_name) === "PermissionRequest" && str(payload.tool_name) !== "ExitPlanMode";
}

/**
 * 「总是允许」写进会话的规则。优先用 Claude Code 自己给的 permission_suggestions
 * （它知道 Bash 前缀该怎么切），没有才退回整个工具名。
 */
export function alwaysPermissions(payload: ClaudeHookPayload): unknown[] {
  const suggestions = payload.permission_suggestions;
  if (Array.isArray(suggestions)) {
    const rules = suggestions.filter(
      (s) => s && typeof s === "object" && (s as Record<string, unknown>).type === "addRules",
    );
    if (rules.length > 0) {
      return rules.map((s) => ({ ...(s as Record<string, unknown>), destination: "session" }));
    }
  }
  // 没有现成规则（2.1.280 实测：普通 Bash 授权只给 addDirectories / setMode 两种建议）：
  // Bash 按命令首词放行（Bash(touch:*)，与发键卡「总是允许 touch …」同粒度），其余工具整个放行。
  const tool = str(payload.tool_name) ?? "";
  const command = tool === "Bash" ? str(inputObject(payload).command)?.trim().split(/\s+/)[0] : null;
  return [{
    type: "addRules",
    rules: [command ? { toolName: tool, ruleContent: `${command}:*` } : { toolName: tool }],
    behavior: "allow",
    destination: "session",
  }];
}

/**
 * 校验并规范化一次作答。返回 null = 这份作答与交互种类 / 题目对不上（路由回 400）。
 * AskUserQuestion：每道题都要答；单选必须是选项之一或自由文本；多选用 ", " 连接 label。
 */
export function validateResolution(
  kind: BlockingKind,
  payload: ClaudeHookPayload,
  body: unknown,
): InteractionResolution | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (kind === "question") {
    if (b.type !== "answers" || !b.answers || typeof b.answers !== "object") return null;
    const given = b.answers as Record<string, unknown>;
    const answers: Record<string, string> = {};
    for (const q of askQuestions(payload.tool_input)) {
      const raw = given[q.question];
      const text = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").join(", ")
        : typeof raw === "string" ? raw.trim() : "";
      if (!text || text.length > 4000) return null;
      answers[q.question] = text;
    }
    return Object.keys(answers).length > 0 ? { type: "answers", answers } : null;
  }
  if (kind === "permission") {
    if (b.type !== "permission" || typeof b.allow !== "boolean") return null;
    if (b.allow) return { type: "permission", allow: true, ...(b.always === true && supportsAlways(payload) ? { always: true } : {}) };
    const message = typeof b.message === "string" ? b.message.trim().slice(0, 4000) : "";
    return { type: "permission", allow: false, ...(message ? { message } : {}) };
  }
  if (b.type !== "plan" || typeof b.approve !== "boolean") return null;
  if (b.approve) {
    if (b.mode !== "bypassPermissions" && b.mode !== "acceptEdits") return null;
    return { type: "plan", approve: true, mode: b.mode };
  }
  const feedback = typeof b.feedback === "string" ? b.feedback.trim().slice(0, 8000) : "";
  return { type: "plan", approve: false, ...(feedback ? { feedback } : {}) };
}

function permissionDecision(decision: Record<string, unknown>): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/** 作答 → hook 打到 stdout 的 JSON。 */
export function hookOutput(payload: ClaudeHookPayload, resolution: InteractionResolution): Record<string, unknown> {
  const input = inputObject(payload);
  switch (resolution.type) {
    case "answers":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "已在 Trellis 作答",
          updatedInput: { ...input, answers: resolution.answers },
        },
      };
    case "permission":
      if (!resolution.allow) {
        return permissionDecision({ behavior: "deny", message: resolution.message || "用户在 Trellis 上拒绝了这次调用。" });
      }
      return permissionDecision({
        behavior: "allow",
        updatedInput: input,
        ...(resolution.always ? { updatedPermissions: alwaysPermissions(payload) } : {}),
      });
    case "plan":
      if (!resolution.approve) {
        const msg = "用户在 Trellis 上打回了这个计划。" + (resolution.feedback ? `修改意见：${resolution.feedback}` : "请重新规划。");
        return permissionDecision({ behavior: "deny", message: msg });
      }
      // 单纯 allow 关不掉计划对话框：必须同时带 updatedInput 和 setMode。
      // bypassPermissions 只在会话本身以 bypass 启动时可用，否则 Claude Code 忽略这条 setMode
      // （2.1.280 debug 日志实测：「mode is not available」，会话掉回 manual）。所以先 setMode auto
      // 垫底（TUI 计划卡的「Yes, and use auto mode」同款），再 setMode bypassPermissions：
      // 按序生效，可用就是 bypass，不可用停在 auto。
      return permissionDecision({
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: resolution.mode === "bypassPermissions"
          ? [
              { type: "setMode", mode: "auto", destination: "session" },
              { type: "setMode", mode: "bypassPermissions", destination: "session" },
            ]
          : [{ type: "setMode", mode: resolution.mode, destination: "session" }],
      });
  }
}

/** 摘要里要给前端的那部分载荷字段：卡片只靠它就能画，不依赖观测 hook 的记录先到。 */
export function summaryFields(
  kind: BlockingKind,
  payload: ClaudeHookPayload,
): Pick<BlockingSummary, "questions" | "summary" | "plan" | "canAlways"> {
  const input = inputObject(payload);
  if (kind === "question") return Array.isArray(input.questions) ? { questions: input.questions } : {};
  if (kind === "plan") {
    const plan = str(input.plan);
    return plan ? { plan } : {};
  }
  return { summary: approvalSummary(payload), canAlways: supportsAlways(payload) };
}
