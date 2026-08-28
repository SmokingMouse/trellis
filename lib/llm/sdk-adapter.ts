// trellis ↔ @smokingmouse/agent(~/sdk)SDK 的转换层。
// SDK 暴露细粒度 RunOptions(机制)+ 统一 AgentEvent;trellis 在这里把自己的
// mode(策略)映射成 RunOptions,把 AgentEvent 转回自己的 StreamEvent。
// 这一层是"反向依赖 SDK"的关键:SDK 不认 trellis 的 mode/prompt,全部留在此。
// 模型/endpoints.yaml 解析已经下沉进 SDK 的 ClaudeBackend 内部(见 @smokingmouse/agent/backends/
// claude.ts)——这里的 `model` 字段只是原样透传,不在这一层再手动解析 endpoint/拼 env。

import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { EventType, type AgentEvent, type RunOptions } from "@smokingmouse/agent";
import type { TaskMeta } from "@/lib/types";
import type { AgentSpawn, Mode, StreamEvent, StreamRequest } from "./types";
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

// 权限确认模式的 ask 规则：agent@0.8.0 起用 "all"（CLI `permissions.ask:["*"]`），
// **全部**工具进 can_useTool 回调，压过用户全局 settings.json 的 allow 规则
// （本机裸 "Bash" 全放行，2026-07-15 实测不注入 ask 则回调永不触发）。
// 换 "all" 的动机：旧名单（Bash/Write/Edit/MultiEdit/NotebookEdit）之外的可变更
// 工具会被全局 allowlist 静默放行——MCP 工具是最大的洞（mcp__* 名字排列组合，
// 名单穷举不完）。「哪些免审」的判断随之挪进 run-bus 的 dispatcher（只读工具
// 自动放行名单 READONLY_AUTO_ALLOW），SDK 层只负责「全都送进来」。
const APPROVAL_ASK_TOOLS = "all" as const;

/** S88: 把自定义 Agent 叠加到已算好的 RunOptions 上。
 *
 * 刻意做成「三个 mode 分支之后的统一后处理」而不是新增分支 —— chat / enhanced chat /
 * project 已经够难读，再乘一个「有没有 agent」维度就是 6 个分支。
 *
 * 铁律：**agent 只改「人设 + 能力面」，绝不碰「上下文与身份」**。
 * workspace / cwd / resume / forkSession / persistence / attachments / env /
 * onCanUseTool 一概不动 —— 那几个字段撑着 chat B-fork 和 project 的 per-lineage
 * isolation 两套本来就很脆的机制，agent 掺一脚必炸。 */
function applyAgent(base: RunOptions, a: AgentSpawn): RunOptions {
  const out: RunOptions = { ...base };

  if (a.runtime === "codex") {
    // Codex has no --agent registry. Preserve the same product-level persona
    // by replacing the mode prompt with the resolved agent prompt. Selected
    // skills have already been inlined by agent-pack.ts.
    out.systemPrompt = a.systemPrompt;
    if (!a.inheritEnv) {
      out.environmentSkills = false;
      out.environmentSkillNames = a.environmentSkillNames;
    }
    if (a.model) out.model = a.model;
    if (a.permission) out.permission = a.permission;
    return out;
  }

  // --agent 与 --system-prompt 互斥（后者是整体替换，前者是激活人设，同给的优先级
  // CLI 无文档）。agent 的人设已完整躺在 --agents JSON 的 prompt / pack 的 md 正文里，
  // 这里直接删掉 systemPrompt，不做 append —— 混合两个人设来源是日后
  // 「为什么它不听我的」的温床。
  delete out.systemPrompt;

  out.agent = a.slug;
  if (a.pluginDir) out.pluginDirs = [a.pluginDir];
  if (a.agentsJson) out.agents = a.agentsJson;

  if (!a.inheritEnv) {
    // 隔离 = 不读本机 CLAUDE.md / settings / skill。**连 MCP 一起没了**
    // （2026-07-31 实测，见 progress/facts.md）—— 这是产品事实不是 bug，
    // UI 上必须讲明白。想给隔离 agent 配 MCP 只能显式走 --mcp-config（未做）。
    out.settingSources = false;
  }

  // 下面这些「显式配了才覆盖」：没配就保持 mode 分支算出来的值。
  // 例如 project 不配 tools 就仍是全工具，纯 chat 不配就仍是 WebSearch/WebFetch。
  if (a.model) out.model = a.model;
  if (a.tools) out.tools = a.tools;
  if (a.disallowedTools?.length) out.disallowedTools = a.disallowedTools;
  if (a.permission) out.permission = a.permission;

  // agent 可以强制开审批（requireApproval=true）。关掉（false）也认，但只在
  // 交互回调在场时有意义 —— 没有 onCanUseTool 时 askTools 本就是死字段。
  if (a.requireApproval === true && base.onCanUseTool) {
    out.permission = a.permission ?? "default";
    out.askTools = APPROVAL_ASK_TOOLS;
  } else if (a.requireApproval === false) {
    delete out.askTools;
  }

  return out;
}

/** trellis mode + StreamRequest → SDK RunOptions(细粒度机制)。 */
export function modeToRunOptions(mode: Mode, model: string, req: StreamRequest): RunOptions {
  let base = baseRunOptions(mode, model, req);
  // @提及的一次性 spawn：把三个 mode 分支算出来的身份统统抹掉。放在 applyAgent
  // **之前** —— agent 那层的铁律是不碰身份，抹身份这件事必须显式、独立、可搜。
  if (req.ephemeral) {
    base = { ...base, persistence: false, forkSession: false };
    delete base.resume;
  }
  if (req.extraArgs?.length) base = { ...base, extraArgs: req.extraArgs };
  const out = req.agent ? applyAgent(base, req.agent) : base;
  // 平台 env 放在 applyAgent **之后**统一收尾：agent 层的铁律是不碰上下文与
  // 身份，而「你在哪」正是上下文 —— 自定义 agent、@提及、任务 run 一视同仁
  // 都拿到。合并进已有 env（纯 chat 的 CLAUDE_CODE_EFFORT_LEVEL）而不是覆盖。
  const penv = platformEnv(req);
  return penv ? { ...out, env: { ...out.env, ...penv } } : out;
}

/** 平台自感知 env（对标 Herdr 注入 HERDR_ENV / HERDR_PANE_ID）。
 *
 * 子进程里的 trellisctl / 任意脚本靠这四个变量回答「我在 Trellis 里吗、我是
 * 哪个会话的哪个节点、API 在哪」。TRELLIS_URL 只在 TRELLIS_PORT 在场时注 ——
 * 那是 server.ts（大门）boot Next 时传下来的 gate 端口；`next dev` 裸跑没有
 * 大门，这时注一个探不通的 URL 反而会让 trellisctl 直接 die（它对显式 URL
 * 不做降级），宁可让它走默认端口发现链。
 *
 * 注意 process.env.PORT 在 Next 进程里是**内部口**（server.ts bootNext 设成
 * NEXT_PORT），/__gate/health 不在那层，绝不能拿它拼 URL。 */
function platformEnv(req: StreamRequest): Record<string, string> | null {
  if (!req.platform) return null;
  const gatePort = process.env.TRELLIS_PORT;
  return {
    TRELLIS_ENV: "1",
    ...(gatePort ? { TRELLIS_URL: `http://127.0.0.1:${gatePort}` } : {}),
    TRELLIS_SESSION_ID: req.platform.sessionId,
    TRELLIS_NODE_ID: req.platform.nodeId,
  };
}

function baseRunOptions(mode: Mode, model: string, req: StreamRequest): RunOptions {
  const common: RunOptions = { model, attachments: req.attachments };
  // 权限确认仅在交互回调在场时生效。run-bus 给 claude / codex 建回调（claude 走
  // stdio can_use_tool；codex 自 agent@0.7.0 走 app-server requestApproval，SDK
  // 映射成同一 onCanUseTool 形状，toolName 也对齐 Bash/Edit）；mock 无审批概念。
  const approve = req.requireApproval === true && !!req.onCanUseTool;
  if (mode === "chat") {
    const sp = req.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    // chat B-fork: persist + resume the parent's forked session so the CLI
    // keeps history as immutable, cache-hit message blocks. forkSession is
    // honored by ClaudeBackend only when resume is set, so the first turn
    // (resume undefined) spawns a fresh session without --fork-session.
    // codex rides the same flag since 2026-07-26: CodexBackend ignores
    // forkSession itself but honors persistence+resume（`codex exec resume`，
    // 分叉隔离由 route 侧的前缀 rollout 完成）; depth>=1 / 存量会话仍走
    // folded-history（req.forkSession=false）。
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
    // 不设则 @smokingmouse/agent 回退进程 cwd(trellis 项目目录),与校验用的 CHAT_SCRATCH
    // 错位 → resume 自愈误判 jsonl 不存在 → 全 fresh → 失忆。cwd 与 workspace
    // 正交:给 cwd 稳定落盘、不给 workspace 保持无文件工具。
    // settingSources:false:稳定 cwd 会让 claude 向上找到项目/全局 CLAUDE.md 污染
    // 纯对话人设,且白搭 token —— 纯对话本就只要 DEFAULT_SYSTEM_PROMPT + web,关掉。
    return {
      ...common,
      // D1: user can override the chat persona per-session; fall back to the
      // built-in default when unset/blank.
      systemPrompt: sp,
      // Claude uses this allowlist. Codex ignores it and exposes its native
      // cached web search; makeCodexProvider applies environment isolation.
      tools: ["WebSearch", "WebFetch"],
      cwd: req.cwd ?? CHAT_SCRATCH,
      settingSources: false,
      // 纯对话 = GPT 式即答场景:effort 压到 low,否则默认 effort 下模型对
      // "你好"级问题也先思考半天(alwaysday1 等端点尤甚),chat 手感差。仅纯
      // 对话——增强 chat / project 是干活 agent,保持 CLI 默认不
      // 降智。instrumentation.ts 已 scrub 继承的 CLAUDE_CODE_EFFORT_LEVEL,
      // 这里是唯一显式下发点(RunOptions.env 优先级高于继承的进程 env)。
      env: { CLAUDE_CODE_EFFORT_LEVEL: "low" },
      ...forkOpts,
    };
  }
  // project:像 Projects,整棵树共享一个 session(resume),持久化。
  // A路②: onCanUseTool 开启 stdio 权限协议,非交互工具由 run-bus 的
  // dispatcher 立即 auto-allow(保持 bypass YOLO),仅交互工具暂停等用户。
  // 权限确认(approve):permission 降为 default + ask 规则,可变更工具全部
  // 进 can_use_tool,由 dispatcher 暂停弹权限卡。
  return {
    ...common,
    workspace: req.cwd ?? os.homedir(),
    permission: approve ? "default" : "full",
    ...(approve ? { askTools: APPROVAL_ASK_TOOLS } : {}),
    persistence: true,
    resume: req.claudeSessionId ?? undefined,
    onCanUseTool: req.onCanUseTool,
  };
}

/** SDK AgentEvent → trellis StreamEvent。 */
export function toStreamEvent(e: AgentEvent): StreamEvent | null {
  switch (e.type) {
    case EventType.TextChunk:
      return { type: "delta", text: String(e.data.text ?? "") };
    case EventType.Thinking:
      return { type: "thinking", text: String(e.data.text ?? "") };
    case EventType.ToolCall:
      return {
        type: "tool_call_start",
        id: String(e.data.id ?? ""),
        name: String(e.data.name ?? ""),
        input: e.data.input,
        startedAt: Date.now(),
        parentToolUseId: (e.data.parentToolUseId as string | null) ?? null,
      };
    case EventType.Task: {
      // 后台 task 生命周期 → 挂回派生它的那条调用（data.toolUseId，SDK 已保证非
      // 空）。字段原样浅合并；SDK 侧已剔过 undefined（patch 语义下留着会抹掉先前
      // phase 的值）。
      //
      // phase/taskId 曾经在这里被丢掉，是「慢 Bash 被当成子 Agent」的一半成因：
      // 真正的判别位 taskType 只在 task_started 出现，阶段信息一丢就再也分不清一
      // 条 task 是什么。现在两个都留 —— taskId 的首字母（a/b/w）还是 SDK 没抽
      // taskType 时（旧版本 / 其他后端）的兜底判据。
      const { toolUseId, ...rest } = e.data as Record<string, unknown>;
      if (!toolUseId) return null;
      const agent = rest as TaskMeta;
      if (agent.taskId !== undefined) agent.taskId = String(agent.taskId);
      return { type: "tool_call_update", id: String(toolUseId), agent };
    }
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
      // lands (or drops it for codex/mock chat).
      return e.sessionId
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
