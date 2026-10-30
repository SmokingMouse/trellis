"use client";
import { create } from "zustand";
import type { Role, RoleInput, RoleMemoryList, RoleOpenResult } from "@/lib/roles";

// 角色列表 + CRUD + 一览开关。独立于 sessionStore（理由同 agentStore / butlerStore：
// 角色管理与会话流式状态零交集）。打开角色对话（草稿态 / previewSession）的那一步
// 在 sessionStore.openRole，这里只负责数据。接口契约见 docs/roles-p1.md。

type RoleState = {
  roles: Role[];
  loaded: boolean;
  error: string | null;
  /** 角色 id → 记忆列表缓存（一览面板、设置页共用） */
  memories: Record<string, RoleMemoryList>;
  /** 角色 id → 上面那份缓存是什么时候拉回来的（ms）。「记下了…」行据此判断
   * 「列表里没有这个文件」是真被删了，还是列表比这一轮还旧。 */
  memoriesLoadedAt: Record<string, number>;
  /** 一览右栏是否展开（桌面） */
  glanceOpen: boolean;
  /** 新建弹窗是否打开（侧栏 ＋、设置页、手机首页共用一个） */
  newRoleOpen: boolean;
  refresh: () => Promise<void>;
  create: (input: RoleInput) => Promise<Role | string>;
  update: (id: string, patch: Partial<RoleInput>) => Promise<Role | string>;
  remove: (id: string) => Promise<string | null>;
  open: (id: string) => Promise<RoleOpenResult | null>;
  loadMemories: (id: string) => Promise<RoleMemoryList | null>;
  setGlanceOpen: (open: boolean) => void;
  setNewRoleOpen: (open: boolean) => void;
};

/** 成功返回数据，失败返回错误文案。 */
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

export const useRoleStore = create<RoleState>((set, get) => ({
  roles: [],
  loaded: false,
  error: null,
  memories: {},
  memoriesLoadedAt: {},
  glanceOpen: true,
  newRoleOpen: false,

  refresh: async () => {
    const r = await call<{ roles: Role[] }>("/api/roles");
    if (typeof r === "string") set({ error: r, loaded: true });
    else set({ roles: r.roles, error: null, loaded: true });
  },

  create: async (input) => {
    const r = await call<{ role: Role }>("/api/roles", { method: "POST", body: JSON.stringify(input) });
    if (typeof r === "string") return r;
    await get().refresh();
    return r.role;
  },

  update: async (id, patch) => {
    const r = await call<{ role: Role }>(`/api/roles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (typeof r === "string") return r;
    set((s) => ({ roles: s.roles.map((x) => (x.id === id ? r.role : x)) }));
    return r.role;
  },

  remove: async (id) => {
    const r = await call<{ ok: true }>(`/api/roles/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (typeof r === "string") return r;
    set((s) => ({ roles: s.roles.filter((x) => x.id !== id) }));
    return null;
  },

  open: async (id) => {
    const r = await call<RoleOpenResult>(`/api/roles/${encodeURIComponent(id)}/open`, { method: "POST" });
    return typeof r === "string" ? null : r;
  },

  loadMemories: async (id) => {
    const startedAt = Date.now();
    const r = await call<RoleMemoryList>(`/api/roles/${encodeURIComponent(id)}/memories`);
    if (typeof r === "string") return null;
    set((s) => ({
      memories: { ...s.memories, [id]: r },
      memoriesLoadedAt: { ...s.memoriesLoadedAt, [id]: startedAt },
    }));
    return r;
  },

  setGlanceOpen: (open) => set({ glanceOpen: open }),
  setNewRoleOpen: (open) => set({ newRoleOpen: open }),
}));
