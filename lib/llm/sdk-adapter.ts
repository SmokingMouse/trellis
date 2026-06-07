// trellis ↔ agent-gateway SDK 的转换层。
// SDK 暴露细粒度 RunOptions(机制)+ 统一 AgentEvent;trellis 在这里把自己的
// mode(策略)映射成 RunOptions,把 AgentEvent 转回自己的 StreamEvent。
// 这一层是"反向依赖 SDK"的关键:SDK 不认 trellis 的 mode/prompt,全部留在此。

import os from "node:os";
import { EventType, type AgentEvent, type RunOptions } from "agent-gateway";
import type { Mode, StreamEvent, StreamRequest } from "./types";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";

/** trellis mode + StreamRequest → SDK RunOptions(细粒度机制)。 */
export function modeToRunOptions(mode: Mode, model: string, req: StreamRequest): RunOptions {
  const common: RunOptions = { model, attachments: req.attachments };
  if (mode === "chat") {
    // 像 GPT web 客户端:替换 system prompt + 仅 web 工具 + 不落盘。无 workspace。
    return {
      ...common,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      tools: ["WebSearch", "WebFetch"], // claude 用;codex 无 web,backend 自行忽略
      persistence: false,
    };
  }
  if (mode === "workspace") {
    // 像一次性 Claude Code CLI:全工具 + bypass,cwd 绑工作区,每轮无状态。
    return { ...common, workspace: req.cwd ?? os.homedir(), permission: "full", persistence: false };
  }
  // project:像 Projects,整棵树共享一个 session(resume),持久化。
  return {
    ...common,
    workspace: req.cwd ?? os.homedir(),
    permission: "full",
    persistence: true,
    resume: req.claudeSessionId ?? undefined,
  };
}

/** SDK AgentEvent → trellis StreamEvent。project 模式才 emit session_init。 */
export function toStreamEvent(e: AgentEvent, mode: Mode): StreamEvent | null {
  switch (e.type) {
    case EventType.TextChunk:
      return { type: "delta", text: String(e.data.text ?? "") };
    case EventType.ToolCall:
      return {
        type: "tool_call_start",
        id: String(e.data.id ?? ""),
        name: String(e.data.name ?? ""),
        input: e.data.input,
        startedAt: Date.now(),
      };
    case EventType.ToolCallDone:
      return {
        type: "tool_call_done",
        id: String(e.data.id ?? ""),
        output: (e.data.output ?? null) as string | null,
        stderr: (e.data.stderr ?? null) as string | null,
        isError: Boolean(e.data.isError),
        endedAt: Date.now(),
      };
    case EventType.Result: {
      const c = e.data.cost as
        | { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreation?: number }
        | undefined;
      return {
        type: "done",
        usage: {
          input: c?.inputTokens ?? 0,
          output: c?.outputTokens ?? 0,
          cacheRead: c?.cachedTokens ?? 0,
          cacheCreation: c?.cacheCreation ?? 0,
        },
      };
    }
    case EventType.SessionStart:
      // project 据此把 claude/codex 的 session id 存进 nodes.claude_session_id。
      return mode === "project" && e.sessionId ? { type: "session_init", sessionId: e.sessionId } : null;
    case EventType.Error:
      return { type: "error", message: String(e.data.message ?? "agent error") };
    default:
      return null; // file_change 等 trellis 暂不消费
  }
}

/** project 模式只把当轮问题发给 agent(历史在 resume 的会话里)。 */
export function buildProjectPrompt(
  question: string,
  parentAnchor?: { selectedText: string } | null,
): string {
  if (parentAnchor?.selectedText) {
    return `从你上一段中我选中了「${parentAnchor.selectedText}」，继续问：${question}`;
  }
  return question;
}
