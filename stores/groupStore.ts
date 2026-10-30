"use client";
import { create } from "zustand";
import type { Group, GroupInput, GroupPatch, GroupRound } from "@/lib/groups";

// 群聊列表 + CRUD + 每个群当前的轮次状态（docs/roles-p2.md B）。独立于 sessionStore：
// 群消息本身是会话节点，照常住在 sessionStore.nodes；这里只管「群」这层壳和轮次条。
// 实时轮次 / 新消息由 hooks/useGroupEvents 订阅 /api/groups/[id]/events 喂进来。

type GroupState = {
  groups: Group[];
  loaded: boolean;
  error: string | null;
  /** 会话 id → 当前轮次（null = 没在进行）。来自事件流，比 groups[].round 新。 */
  rounds: Record<string, GroupRound | null>;
  /** 新建群聊弹窗 */
  newGroupOpen: boolean;
  refresh: () => Promise<void>;
  create: (input: GroupInput) => Promise<Group | string>;
  update: (id: string, patch: GroupPatch) => Promise<Group | string>;
  archive: (id: string) => Promise<string | null>;
  /** 发一条群消息。成功返回 null，失败返回错误文案（409 = 这一轮还没完）。 */
  send: (id: string, text: string, provider?: string) => Promise<string | null>;
  continueRound: (id: string, provider?: string) => Promise<string | null>;
  stop: (id: string) => Promise<void>;
  setRound: (id: string, round: GroupRound | null) => void;
  setNewGroupOpen: (open: boolean) => void;
};

async function call<T>(url: string, init?: RequestInit): Promise<T | string> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return j?.error ?? `HTTP ${res.status}`;
    return j;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const enc = encodeURIComponent;

export const useGroupStore = create<GroupState>((set, get) => ({
  groups: [],
  loaded: false,
  error: null,
  rounds: {},
  newGroupOpen: false,

  refresh: async () => {
    const r = await call<{ groups: Group[] }>("/api/groups");
    if (typeof r === "string") set({ error: r, loaded: true });
    else set({ groups: r.groups, error: null, loaded: true });
  },

  create: async (input) => {
    const r = await call<{ group: Group }>("/api/groups", { method: "POST", body: JSON.stringify(input) });
    if (typeof r === "string") return r;
    set((s) => ({ groups: [r.group, ...s.groups.filter((g) => g.id !== r.group.id)] }));
    return r.group;
  },

  update: async (id, patch) => {
    const r = await call<{ group: Group }>(`/api/groups/${enc(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (typeof r === "string") return r;
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? r.group : g)) }));
    return r.group;
  },

  archive: async (id) => {
    const r = await call<{ ok: true }>(`/api/groups/${enc(id)}`, { method: "DELETE" });
    if (typeof r === "string") return r;
    set((s) => ({ groups: s.groups.filter((g) => g.id !== id) }));
    return null;
  },

  send: async (id, text, provider) => {
    const r = await call<{ round: GroupRound | null }>(`/api/groups/${enc(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, ...(provider ? { provider } : {}) }),
    });
    if (typeof r === "string") return r;
    // 事件流随后会推更新的状态；先放一份，轮次条不用等。
    if (r.round) get().setRound(id, r.round);
    return null;
  },

  continueRound: async (id, provider) => {
    const r = await call<{ round: GroupRound }>(`/api/groups/${enc(id)}/continue`, {
      method: "POST",
      body: JSON.stringify(provider ? { provider } : {}),
    });
    if (typeof r === "string") return r;
    get().setRound(id, r.round);
    return null;
  },

  stop: async (id) => {
    await call(`/api/groups/${enc(id)}/stop`, { method: "POST", body: "{}" });
  },

  setRound: (id, round) =>
    set((s) => {
      const live = round && (round.status === "running" || round.status === "routing") ? round : null;
      // 一轮结束：列表里的「最近活动 / 最后一句」跟着变，重拉一次。
      if (!live && s.rounds[id]) void get().refresh();
      return { rounds: { ...s.rounds, [id]: live } };
    }),

  setNewGroupOpen: (open) => set({ newGroupOpen: open }),
}));

/** 这个群当前是否有一轮在进行（routing / running）。 */
export function isRoundLive(round: GroupRound | null | undefined): round is GroupRound {
  return !!round && (round.status === "running" || round.status === "routing");
}
