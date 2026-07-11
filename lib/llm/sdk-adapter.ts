// trellis ↔ @sm/agent(~/sdk)SDK 的转换层。
// SDK 暴露细粒度 RunOptions(机制)+ 统一 AgentEvent;trellis 在这里把自己的
// mode(策略)映射成 RunOptions,把 AgentEvent 转回自己的 StreamEvent。
// 这一层是"反向依赖 SDK"的关键:SDK 不认 trellis 的 mode/prompt,全部留在此。
// 模型/endpoints.yaml 解析已经下沉进 SDK 的 ClaudeBackend 内部(见 @sm/agent/backends/
// claude.ts)——这里的 `model` 字段只是原样透传,不在这一层再手动解析 endpoint/拼 env。

import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { EventType, type AgentEvent, type RunOptions } from "@sm/agent";
import type { Mode, StreamEvent, StreamRequest } from "./types";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";

// chat enhanced-mode scratch workspace (shared by claude + codex). Giving chat
// a workspace flips it out of the no-tool / readonly sandbox so it can run
// skills + the web. Providers call ensureChatScratch() before spawning.
export const CHAT_SCRATCH = path.join(os.homedir(), ".trellis", "chat-scratch");
export function ensureChatScratch(): void {
  try {
    mkdirSync(CHAT_SCRATCH, { recursive: true });
  } catch {
    /* exists / unwritable — provider surfaces errors */
  }
}

/** trellis mode + StreamRequest → SDK RunOptions(细粒度机制)。 */
export function modeToRunOptions(mode: Mode, model: string, req: StreamRequest): RunOptions {
  const common: RunOptions = { model, attachments: req.attachments };
  if (mode === "chat") {
    const sp = req.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    // chat B-fork (claude only): persist + resume the parent's forked session so
    // the CLI keeps history as immutable, cache-hit message blocks. forkSession
    // is honored by agent-gateway only when resume is set, so the first turn
    // (resume undefined) spawns a fresh session without --fork-session. codex
    // leaves req.forkSession false → no persist, folded-history path unchanged.
    const forkOpts: RunOptions = req.forkSession
      ? {
          persistence: true,
          resume: req.claudeSessionId ?? undefined,
          forkSession: true,
        }
      : { persistence: false };
    if (req.chatEnhanced) {
      // 增强模式:scratch workspace + full → 无沙箱 → 能跑 skill + 联网 + 工具
      // (YOLO)。claude 拿全工具;codex 的 full 整体绕过沙箱。
      // A路②: enhanced chat can also hit AskUserQuestion/ExitPlanMode, so it
      // gets the interaction callback too.
      return {
        ...common,
        systemPrompt: sp,
        workspace: CHAT_SCRATCH,
        permission: "full",
        ...forkOpts,
        onCanUseTool: req.onCanUseTool,
      };
    }
    // 纯对话:替换 system prompt + 仅 web 工具。无 workspace(无文件工具)。
    // 但 cwd 必须给 —— B-fork 的 session jsonl 落在 cwd 编码目录,spawn/resume
    // 校验/清理三处必须同一个 cwd。req.cwd = sessionCwd(chat) = CHAT_SCRATCH;
    // 不设则 agent-gateway 回退进程 cwd(trellis 项目目录),与校验用的 CHAT_SCRATCH
    // 错位 → resume 自愈误判 jsonl 不存在 → 全 fresh → 失忆。cwd 与 workspace
    // 正交:给 cwd 稳定落盘、不给 workspace 保持无文件工具。
    // settingSources:false:稳定 cwd 会让 claude 向上找到项目/全局 CLAUDE.md 污染
    // 纯对话人设,且白搭 token —— 纯对话本就只要 DEFAULT_SYSTEM_PROMPT + web,关掉。
    return {
      ...common,
      // D1: user can override the chat persona per-session; fall back to the
      // built-in default when unset/blank.
      systemPrompt: sp,
      tools: ["WebSearch", "WebFetch"], // claude 用;codex 无 web,backend 自行忽略
      cwd: req.cwd ?? CHAT_SCRATCH,
      settingSources: false,
      ...forkOpts,
    };
  }
  if (mode === "workspace") {
    // 像一次性 Claude Code CLI:全工具 + bypass,cwd 绑工作区,每轮无状态。
    // A路②: onCanUseTool 开启 stdio 权限协议,非交互工具由 run-bus 的
    // dispatcher 立即 auto-allow(保持 bypass YOLO),仅交互工具暂停等用户。
    return {
      ...common,
      workspace: req.cwd ?? os.homedir(),
      permission: "full",
      persistence: false,
      onCanUseTool: req.onCanUseTool,
    };
  }
  // project:像 Projects,整棵树共享一个 session(resume),持久化。
  return {
    ...common,
    workspace: req.cwd ?? os.homedir(),
    permission: "full",
    persistence: true,
    resume: req.claudeSessionId ?? undefined,
    onCanUseTool: req.onCanUseTool,
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
        | {
            inputTokens?: number;
            outputTokens?: number;
            cachedTokens?: number;
            cacheCreation?: number;
            contextTokens?: number | null;
          }
        | undefined;
      return {
        type: "done",
        usage: {
          input: c?.inputTokens ?? 0,
          output: c?.outputTokens ?? 0,
          cacheRead: c?.cachedTokens ?? 0,
          cacheCreation: c?.cacheCreation ?? 0,
          contextTokens: c?.contextTokens ?? null,
        },
      };
    }
    case EventType.SessionStart:
      // project (root-shared id) + chat B-fork (per-node forked id) both need
      // the session id written back; run-bus's sessionIdTarget decides where it
      // lands (or drops it for codex/mock chat). workspace stays stateless.
      return (mode === "project" || mode === "chat") && e.sessionId
        ? { type: "session_init", sessionId: e.sessionId }
        : null;
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
