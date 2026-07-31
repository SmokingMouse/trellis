"use client";
import { create } from "zustand";

// S88: 自定义 Agent 的列表 + CRUD。
//
// 刻意**不塞进 stores/sessionStore.ts** —— 那个已经 3000+ 行，而 agent 管理是
// 独立路由、独立数据、跟会话流式状态零交集。sessionStore 只需要知道
// `draftAgentId` 一个字段（下一个新会话用谁），列表和编辑全在这里。

export type SkillRef = { kind: "host"; name: string };

export type Agent = {
  id: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  tools: string[] | null;
  disallowedTools: string[] | null;
  skills: SkillRef[];
  inheritEnv: boolean;
  permission: string | null;
  requireApproval: boolean | null;
  builtin: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentInput = Partial<Omit<Agent, "id" | "builtin" | "createdAt" | "updatedAt">> & {
  slug: string;
  name: string;
};

type AgentStore = {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (input: AgentInput) => Promise<Agent | null>;
  update: (id: string, patch: Partial<AgentInput>) => Promise<Agent | null>;
  remove: (id: string) => Promise<boolean>;
};

async function call<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, {
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: d?.error ?? `HTTP ${r.status}` };
    return { ok: true, data: d as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: [],
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    // all=1：管理页要看到停用的那些，picker 不要。
    const r = await call<{ agents: Agent[] }>("/api/agents?all=1");
    if (r.ok) set({ agents: r.data.agents, loading: false });
    else set({ error: r.error, loading: false });
  },

  create: async (input) => {
    const r = await call<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      set({ error: r.error });
      return null;
    }
    set({ agents: [...get().agents, r.data.agent], error: null });
    return r.data.agent;
  },

  update: async (id, patch) => {
    const r = await call<{ agent: Agent }>(`/api/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      set({ error: r.error });
      return null;
    }
    set({
      agents: get().agents.map((a) => (a.id === id ? r.data.agent : a)),
      error: null,
    });
    return r.data.agent;
  },

  remove: async (id) => {
    const r = await call<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" });
    if (!r.ok) {
      set({ error: r.error });
      return false;
    }
    set({ agents: get().agents.filter((a) => a.id !== id), error: null });
    return true;
  },
}));
