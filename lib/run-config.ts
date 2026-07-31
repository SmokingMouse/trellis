// S89: 「运行配置」的文案与语义唯一真源 —— agent / workspace / contextMode / approval
// 这几样，被「开新会话」「定义定时任务」「定义 agent」三处引用。
//
// 为什么是这个形状（而不是一个 <RunConfig> 组件带三种 variant）：
// 三处的**控件形态本来就该不同** —— 新会话是空状态首屏的图标分段器（这是那一屏最重要的
// 选择，值得占地方），任务定义是表单里的一行 select（旁边还有 name/prompt/通知，分段器会
// 喧宾夺主）。硬塞进一个组件只能得到一个巨大的 variant 分支，那是假抽象。
//
// 真正在漂的是**文案和语义**：S88 之后 contextMode 的说明在 ModePicker 里是随 provider 分支
// 的长 title，在任务页里是另手写的「project（有文件工具）」；「不选 agent」在一处叫「默认助手」、
// 另一处叫「默认 Agent」。所以共享的是这些，不是布局。控件本身只共享真正同一个的那个
// （WorkspaceField —— 见 components/run-config/WorkspaceField.tsx）。
//
// 本文件不含 JSX：图标留在各自组件里（lib 不该产出 React 元素）。

import { providerFamily } from "@/lib/llm";
import type { Mode, ProviderId } from "@/lib/llm";

export type ContextModeOption = {
  id: Mode;
  label: string;
  /** 一句话差异。给 select 的选项文字用 —— 那里塞不下完整说明。 */
  short: string;
  /** 完整说明。分段器挂 title、select 挂 title，两处同源。 */
  title: string;
};

/**
 * chat / project 两个上下文模式的文案。随 provider family 变 —— codex 和 claude
 * 在「chat 能不能联网」「project 怎么分叉」上行为不同，说同一句话就会有一边是假的。
 */
export function contextModeOptions(provider: ProviderId): ContextModeOption[] {
  if (providerFamily(provider) === "codex") {
    return [
      {
        id: "chat",
        label: "Chat",
        short: "纯对话，沙箱只读、无联网",
        title:
          "Chat：纯文本回复，沙箱 read-only，禁用所有 tools / MCP。codex 暂无 WebSearch 等价，无联网。",
      },
      {
        id: "project",
        label: "Project",
        short: "有文件工具 + MCP",
        title:
          "Project：一条岔一个 codex session（分叉=前缀 rollout 新 lineage）。MCP/tools 全开。rollout 在 ~/.codex/sessions/，删除 trellis session 时清理。",
      },
    ];
  }
  // Claude (default).
  return [
    {
      id: "chat",
      label: "Chat",
      short: "纯对话 + 联网，不加载 skills",
      title:
        "Chat：纯文本 + WebSearch / WebFetch 联网。不加载 skills / CLAUDE.md。最便宜，对标 GPT 网页客户端。",
    },
    {
      id: "project",
      label: "Project",
      short: "有文件工具 + skills / CLAUDE.md",
      title:
        "Project：在所选仓库 cwd 中加载 skills + CLAUDE.md，一条岔一个 claude session（分叉=前缀 jsonl 新 lineage）。skills/tools 全开。删除 trellis session 时清理对应 jsonl。",
    },
  ];
}

/** project 必须绑一个 cwd；chat 没有 cwd 概念。服务端 chat/route.ts 会再钳一道。 */
export function workspaceRequired(mode: Mode | string | null | undefined): boolean {
  return mode === "project";
}

// ── Agent ────────────────────────────────────────────────────────────────────

/**
 * 「不选 agent」的显示名。它不是一行数据，是 `agent_id IS NULL` 这个状态本身
 * （见 decisions/2026-07-31-custom-agents.md 决策 3）。
 * 曾经新会话叫「默认助手」、任务页叫「默认 Agent」—— 同一个东西两个名字，统一到这个。
 */
export const AGENT_DEFAULT_LABEL = "默认助手";
export const AGENT_DEFAULT_HINT = "今天的行为，读 CLAUDE.md 和本机全部技能";

/** picker 需要的 agent 最小形状。agentStore 的 Agent 是它的超集。 */
export type AgentLike = {
  description: string;
  inheritEnv: boolean;
  tools: string[] | null;
};

/**
 * agent 选项下面那行小字。**隔离的代价必须在选之前说清楚**，不能等它答不出话才发现
 * ——「隔离」= 无 CLAUDE.md + 无本机技能 + 无 MCP 三件套（facts.md 有实测）。
 */
export function agentHint(a: AgentLike): string | undefined {
  return (
    [
      a.description,
      a.inheritEnv ? null : "隔离：无 CLAUDE.md / 本机技能 / MCP",
      a.tools ? `工具：${a.tools.join(" ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined
  );
}

/**
 * agent 只对 claude 家族生效 —— `--agent/--agents/--plugin-dir` 全是 claude CLI 专属，
 * 服务端 chat/route.ts 与 tasks.ts 都会把非 claude 的 agentId 钳成 null。
 * UI 必须跟着说实话，否则就是「配了却静默不生效」。
 */
export function agentSupported(provider: ProviderId): boolean {
  return providerFamily(provider) === "claude";
}

export const AGENT_UNSUPPORTED_HINT =
  "当前模型不是 claude 家族，Agent 不生效（--agent 是 claude CLI 专属，服务端会忽略）";

// ── 权限审批 ──────────────────────────────────────────────────────────────────

export type ApprovalCopy = { icon: string; label: string; title: string };

/** YOLO ↔ 需确认。仅 claude 系的 project 有意义（见 approvalAvailable）。 */
export function approvalCopy(requireApproval: boolean): ApprovalCopy {
  return requireApproval
    ? {
        icon: "🛡️",
        label: "需确认",
        title:
          "需确认：Bash/Write/Edit 等可变更工具逐个弹卡，等你允许/拒绝后才执行（创建会话时锁定）",
      }
    : {
        icon: "⚡",
        label: "YOLO",
        title:
          "YOLO：工具自动放行（现状默认）。点击切换为需确认——可变更工具执行前先问你",
      };
}

/**
 * 审批开关什么时候该露面：只有 claude 系的 project。
 * chat 没有可变更工具；codex 没有 stdio 审批协议，显示了也是谎言。服务端会再钳一道。
 */
export function approvalAvailable(
  mode: Mode | string | null | undefined,
  provider: ProviderId,
): boolean {
  return workspaceRequired(mode) && providerFamily(provider) === "claude";
}

// ── 路径显示 ──────────────────────────────────────────────────────────────────

/** 工作区按钮上显示的短名。路径可能很长，列表里只认最后一段。 */
export function basename(p: string): string {
  if (!p) return "";
  const stripped = p.replace(/\/+$/, "");
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}
