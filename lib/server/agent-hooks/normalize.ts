// 事件 → 状态的归一化。纯函数：给上一条记录和一个 hook payload，算出新记录。
// 不碰 DB、不碰进程状态，所以能被单测穷举。
import { readLastAssistantMessage } from "./transcript";
import type {
  AgentHookRecord,
  ApprovalPrompt,
  ClaudeHookPayload,
  HookState,
} from "./types";

/**
 * AskUserQuestion 是**自动放行**工具 —— 它不会触发 PermissionRequest，
 * 只有 PreToolUse。实测踩过的坑：只认 PermissionRequest 的话，agent 弹了选择
 * 卡在那等着，看板这边显示的还是「working」。
 */
const ASK_USER_QUESTION = "AskUserQuestion";

export type NormalizeOptions = {
  paneKey?: string | null;
  now?: number;
  /** 注入点：单测用假的尾扫，生产用真的读文件。 */
  tailScan?: (transcriptPath: string) => string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function blank(sessionId: string, now: number): AgentHookRecord {
  return {
    sessionId,
    agent: "claude",
    state: "working",
    prompt: null,
    toolName: null,
    toolInput: null,
    interactivePrompt: null,
    lastAssistantMessage: null,
    transcriptPath: null,
    cwd: null,
    paneKey: null,
    subagents: [],
    stashed: null,
    updatedAt: now,
    stateStartedAt: now,
  };
}

/** 子 agent 名：不同 CLI 版本键不一样，挨个试；都没有就给个占位（名单长度才是关键）。 */
function subagentName(p: ClaudeHookPayload): string {
  return (
    str(p.subagent_name) ??
    str(p.subagent_type) ??
    str(p.agent_name) ??
    str(p.agent_type) ??
    "subagent"
  );
}

/** 审批卡的一句话说明。payload 没给现成的就从 tool_input 里挑最有信息量的字段。 */
export function approvalSummary(p: ClaudeHookPayload): string {
  const given = str(p.summary) ?? str(p.message) ?? str(p.reason);
  if (given) return given;
  const input = p.tool_input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "url", "pattern", "description"]) {
      const v = str(o[key]);
      if (v) return v;
    }
  }
  return str(p.tool_name) ?? "";
}

function toApproval(p: ClaudeHookPayload): ApprovalPrompt {
  return {
    approval: { tool: str(p.tool_name) ?? "", summary: approvalSummary(p) },
  };
}

function promptWithOwner(prompt: unknown, payload: ClaudeHookPayload): Record<string, unknown> {
  return {
    ...(prompt && typeof prompt === "object" ? prompt : {}),
    tool_name: str(payload.tool_name),
    ...(str(payload.agent_id) ? { agent_id: payload.agent_id } : {}),
    ...(str(payload.tool_use_id) ? { tool_use_id: payload.tool_use_id } : {}),
  };
}

function closesPrompt(prompt: unknown, payload: ClaudeHookPayload): boolean {
  if (!prompt || typeof prompt !== "object") return true;
  const card = prompt as Record<string, unknown>;
  const legacyTool = card.questions ? ASK_USER_QUESTION : (card.approval as ApprovalPrompt["approval"] | undefined)?.tool;
  return (card.tool_name ?? legacyTool) === payload.tool_name &&
    str(card.agent_id) === str(payload.agent_id) &&
    (!card.tool_use_id || card.tool_use_id === payload.tool_use_id);
}

/**
 * 应用一个 hook 事件。prev = null 表示这个 session 还没有记录。
 * 返回 null = 这条 payload 没有 session_id，无从归属，丢弃。
 */
export function applyHookEvent(
  prev: AgentHookRecord | null,
  payload: ClaudeHookPayload,
  opts: NormalizeOptions = {},
): AgentHookRecord | null {
  const sessionId = str(payload.session_id);
  if (!sessionId) return null;

  const now = opts.now ?? Date.now();
  const tailScan = opts.tailScan ?? readLastAssistantMessage;
  const event = str(payload.hook_event_name) ?? "";
  const prevState: HookState | null = prev ? prev.state : null;

  const next: AgentHookRecord = prev
    ? { ...prev, subagents: [...prev.subagents] }
    : blank(sessionId, now);

  // 每个事件都带的公共字段。空值不覆盖已有的 —— PostToolUse 不带 cwd
  // 不代表这个会话没有 cwd。
  next.transcriptPath = str(payload.transcript_path) ?? next.transcriptPath;
  next.cwd = str(payload.cwd) ?? next.cwd;
  const paneKey = str(opts.paneKey);
  if (paneKey) next.paneKey = paneKey;
  next.updatedAt = now;

  const setState = (s: HookState) => {
    next.state = s;
  };
  const dismiss = () => {
    next.interactivePrompt = null;
  };
  /** 转 waiting 前先把父会话的现场收起来 —— 只在子 agent 在跑时才需要复位。 */
  const stashIfSubagent = () => {
    // A running child does not imply that a prompt belongs to it. Keep the
    // parent's card unless the hook explicitly identifies a child invocation.
    const owner = prev?.interactivePrompt && typeof prev.interactivePrompt === "object"
      ? str((prev.interactivePrompt as Record<string, unknown>).agent_id) : null;
    if ((str(payload.agent_id) || str(payload.subagent_id)) && next.subagents.length > 0 && !next.stashed && prev &&
        (!prev.interactivePrompt || owner !== str(payload.agent_id))) {
      next.stashed = {
        state: prev.state,
        toolName: prev.toolName,
        toolInput: prev.toolInput,
        interactivePrompt: prev.interactivePrompt,
      };
    }
  };

  switch (event) {
    case "SessionStart": {
      // 建记录。刚开的会话没在等人也没结束 —— 归 working（「活着」）。
      setState("working");
      dismiss();
      break;
    }
    case "SessionEnd": {
      next.stashed = null;
      setState("done");
      dismiss();
      break;
    }
    case "UserPromptSubmit": {
      next.stashed = null;
      next.prompt = str(payload.prompt) ?? next.prompt;
      next.toolName = null;
      next.toolInput = null;
      dismiss();
      setState("working");
      break;
    }
    case "PreToolUse": {
      next.toolName = str(payload.tool_name);
      next.toolInput = payload.tool_input ?? null;
      if (next.toolName === ASK_USER_QUESTION) {
        stashIfSubagent();
        next.interactivePrompt = promptWithOwner(payload.tool_input, payload);
        setState("waiting");
      } else if (!next.interactivePrompt) {
        dismiss();
        setState("working");
      }
      break;
    }
    case "PermissionRequest": {
      next.toolName = str(payload.tool_name) ?? next.toolName;
      next.toolInput = payload.tool_input ?? next.toolInput;
      stashIfSubagent();
      next.interactivePrompt = promptWithOwner(toApproval(payload), payload);
      setState("waiting");
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      next.toolName = str(payload.tool_name) ?? next.toolName;
      if (next.stashed?.interactivePrompt && closesPrompt(next.stashed.interactivePrompt, payload)) {
        next.stashed = null;
      }
      if (!closesPrompt(next.interactivePrompt, payload)) break;
      dismiss();
      setState("working");
      break;
    }
    case "Stop":
    case "StopFailure": {
      next.stashed = null;
      dismiss();
      next.toolName = null;
      next.toolInput = null;
      const direct = str(payload.last_assistant_message);
      const scanned =
        direct ?? (next.transcriptPath ? tailScan(next.transcriptPath) : null);
      if (scanned) next.lastAssistantMessage = scanned;
      setState("done");
      break;
    }
    case "SubagentStart": {
      next.subagents.push(subagentName(payload));
      break;
    }
    case "SubagentStop": {
      const name = subagentName(payload);
      const at = next.subagents.lastIndexOf(name);
      if (at >= 0) next.subagents.splice(at, 1);
      else next.subagents.pop();
      if (next.subagents.length === 0 && next.stashed) {
        // 子工具完成会先进入 working；父卡仍在 stash 时也必须复位。
        // 父工具自己的完成事件会清 stash，避免把已答的父卡复活。
        if (next.state === "waiting" ||
            (next.stashed.interactivePrompt && next.interactivePrompt !== next.stashed.interactivePrompt)) {
          next.state = next.stashed.state;
          next.toolName = next.stashed.toolName;
          next.toolInput = next.stashed.toolInput;
          next.interactivePrompt = next.stashed.interactivePrompt;
        }
        next.stashed = null;
      }
      break;
    }
    default:
      // 不认识的事件只刷新 updatedAt / 公共字段，不动状态机。
      break;
  }

  next.stateStartedAt =
    prevState !== null && prevState === next.state
      ? (prev as AgentHookRecord).stateStartedAt
      : now;
  return next;
}
