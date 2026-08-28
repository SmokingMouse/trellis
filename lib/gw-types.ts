/**
 * 网关门户 API 类型定义 (tenancy/gateway/API.md)
 */

export type GwRole = "admin" | "user";

export type GwMe = {
  name: string;
  tenant: string;
  role: GwRole;
};

export type GwContainerState = "running" | "stopped" | "missing" | "host";

export type GwContainerInfo = {
  state: GwContainerState;
  healthy: boolean | null;
};

export type GwAdminUser = {
  name: string;
  tenant: string;
  role: GwRole;
  disabled: boolean;
  createdAt: number;
  container: GwContainerInfo;
};

export type GwInvite = {
  code: string;
  createdAt: number;
  usedBy: string | null;
};

export type GwInviteCreateResponse = {
  code: string;
  url: string;
};

export type GwShareType = "claude-token" | "endpoint";

export type GwShare = {
  id: string;
  type: GwShareType;
  label: string;
  owner: string;
  visibility: "all" | string[];
  createdAt: number;
  subscriberCount: number;
};

export type GwAvailableShare = GwShare & {
  subscribed: boolean;
};

export type GwSharesResponse = {
  published: GwShare[];
  available: GwAvailableShare[];
};

export type GwClaudeTokenPayload = {
  token: string;
};

export type GwEndpointPayload = {
  name?: string;
  anthropic_url?: string;
  openai_url?: string;
  api_key_env?: string;
  apiKey?: string;
  models?: string[];
  [key: string]: unknown;
};

export type GwShareCreateBody = {
  type: GwShareType;
  label: string;
  payload: GwClaudeTokenPayload | GwEndpointPayload;
  visibility: "all" | string[];
};

export type GwSubscribeResponse = {
  willRestart: boolean;
};
