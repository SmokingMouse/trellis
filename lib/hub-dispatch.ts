// 跨机派活（P5）的共享约定：A 机器上的 agent → A 的 /api/hub/dispatch → hub
// /__gw/relay/dispatch → B 的 /api/hub/dispatch-in 新开会话跑一轮。网关、node 侧
// Next 路由按这里的形状说话（trellisctl 要能在仓库外独立跑，按同样形状手写）。

import { goHref } from "./gw-client";

/** prompt 上限（字符）。派活的 prompt 是「把一件事说清楚」，不是搬运上下文 ——
 *  要带大段材料就让目标机器自己去读（它在自己机器上有文件和工具）。 */
export const MAX_DISPATCH_PROMPT = 32_000;

/** 取结果时回答正文的上限（字符），超出截尾并标 truncated。 */
export const MAX_DISPATCH_RESPONSE = 200_000;

/** 网关转给目标机器时带的来源机器名；目标据此标注「由 <A> 派来」并校验取结果的人。 */
export const DISPATCH_FROM_HEADER = "x-trellis-dispatch-from";

export const MACHINE_NAME_RE = /^[a-z0-9-]{1,64}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export type DispatchRequest = {
  machine: string;
  prompt: string;
  /** 目标机器上的工作目录（project 模式）；缺省 = 增强对话（scratch 目录 + 全工具）。 */
  workspace?: string;
  provider?: string;
};

export type DispatchCreated = {
  machine: string;
  sessionId: string;
  nodeId: string;
  /** hub 上点开就切到目标机器、落在这个会话的相对地址。 */
  url: string;
};

export type DispatchState = "running" | "waiting" | "done" | "error";

export type DispatchStatus = {
  machine: string;
  sessionId: string;
  nodeId: string;
  status: DispatchState;
  response: string;
  truncated: boolean;
  errorMessage: string | null;
  /** status=waiting 时：停在哪个交互工具上（要去目标机器界面上回答）。 */
  pendingTool: string | null;
  url: string;
};

export type RelayMachine = {
  name: string;
  self: boolean;
  online: boolean;
  shareOut: boolean;
  acceptDispatch: boolean;
};

export function dispatchURL(machine: string, sessionId: string, nodeId: string): string {
  return goHref(machine, `/?session=${encodeURIComponent(sessionId)}&node=${encodeURIComponent(nodeId)}`);
}

export type DispatchInput = { prompt: string; workspace: string | null; provider: string | null };

/** 校验派活请求体（A 本地、网关、B 三处共用同一份规则）。错误返回人话字符串。 */
export function parseDispatchInput(raw: unknown): DispatchInput | string {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt) return "prompt 不能为空";
  if (prompt.length > MAX_DISPATCH_PROMPT) {
    return `prompt 太长（${prompt.length} 字符，上限 ${MAX_DISPATCH_PROMPT}）—— 大段材料让目标机器自己去读`;
  }
  const workspace = typeof b.workspace === "string" && b.workspace.trim() ? b.workspace.trim() : null;
  if (workspace && (!workspace.startsWith("/") || workspace.length > 1024)) {
    return "workspace 要是目标机器上的绝对路径";
  }
  const provider = typeof b.provider === "string" && b.provider.trim() ? b.provider.trim().slice(0, 200) : null;
  return { prompt, workspace, provider };
}
