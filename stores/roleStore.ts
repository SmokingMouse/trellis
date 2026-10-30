"use client";
import { create } from "zustand";
import type { MemoryType, Role, RoleInput, RoleMemory, RoleMemoryList, RoleOpenResult } from "@/lib/roles";

/** PUT /api/roles/[id]/memories/[file] 的 body。 */
export type RoleMemoryInput = { name: string; description: string; type: MemoryType; body: string };

// 角色列表 + CRUD + 一览开关。独立于 sessionStore（理由同 agentStore / butlerStore：
// 角色管理与会话流式状态零交集）。打开角色对话（草稿态 / previewSession）的那一步
// 在 sessionStore.openRole，这里只负责数据。接口契约见 docs/roles-p1.md。

type RoleState = {
  roles: Role[];
  loaded: boolean;
  error: string | null;
  /** 角色 id → 记忆列表缓存（一览面板、设置页共用） */
  memories: Record<string, RoleMemoryList>;
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
  /** 新建或覆盖一条记忆（file 即 id）。成功返回写入后的记忆，失败返回错误文案。 */
  saveMemory: (id: string, file: string, input: RoleMemoryInput) => Promise<RoleMemory | string>;
  deleteMemory: (id: string, file: string) => Promise<string | null>;
  saveUserMd: (id: string, text: string) => Promise<string | null>;
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
    set((s) => {
      // 记忆开关在记忆列表缓存里也有一份（GET memories 带 memoryEnabled），一起改掉
      const cached = s.memories[id];
      return {
        roles: s.roles.map((x) => (x.id === id ? r.role : x)),
        memories: cached
          ? { ...s.memories, [id]: { ...cached, memoryEnabled: r.role.memoryEnabled } }
          : s.memories,
      };
    });
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
    const r = await call<RoleMemoryList>(`/api/roles/${encodeURIComponent(id)}/memories`);
    if (typeof r === "string") return null;
    set((s) => ({ memories: { ...s.memories, [id]: r } }));
    return r;
  },

  saveMemory: async (id, file, input) => {
    const r = await call<{ memory?: RoleMemory }>(
      `/api/roles/${encodeURIComponent(id)}/memories/${encodeURIComponent(file)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    if (typeof r === "string") return r;
    // 契约没规定 PUT 的返回体：带了 memory 就用，否则按提交的内容在本地拼一条
    const saved: RoleMemory = r.memory ?? { file, ...input, updatedAt: Date.now() };
    set((s) => {
      const cached = s.memories[id];
      const isNew = !cached?.memories.some((m) => m.file === file);
      return {
        memories: cached
          ? {
              ...s.memories,
              [id]: {
                ...cached,
                memories: isNew
                  ? [saved, ...cached.memories]
                  : cached.memories.map((m) => (m.file === file ? saved : m)),
              },
            }
          : s.memories,
        // 侧栏 / 顶栏「记得 N 条」读 roles[].memoryCount，新增时同步 +1
        roles: isNew
          ? s.roles.map((x) => (x.id === id ? { ...x, memoryCount: x.memoryCount + 1 } : x))
          : s.roles,
      };
    });
    return saved;
  },

  deleteMemory: async (id, file) => {
    const r = await call<{ ok: true }>(
      `/api/roles/${encodeURIComponent(id)}/memories/${encodeURIComponent(file)}`,
      { method: "DELETE" },
    );
    if (typeof r === "string") return r;
    set((s) => {
      const cached = s.memories[id];
      const had = cached?.memories.some((m) => m.file === file) ?? true;
      return {
        memories: cached
          ? { ...s.memories, [id]: { ...cached, memories: cached.memories.filter((m) => m.file !== file) } }
          : s.memories,
        roles: had
          ? s.roles.map((x) =>
              x.id === id ? { ...x, memoryCount: Math.max(0, x.memoryCount - 1) } : x,
            )
          : s.roles,
      };
    });
    return null;
  },

  saveUserMd: async (id, text) => {
    const r = await call<{ ok: true }>(`/api/roles/${encodeURIComponent(id)}/user-md`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    });
    if (typeof r === "string") return r;
    set((s) => {
      const cached = s.memories[id];
      return cached ? { memories: { ...s.memories, [id]: { ...cached, userMd: text } } } : {};
    });
    return null;
  },

  setGlanceOpen: (open) => set({ glanceOpen: open }),
  setNewRoleOpen: (open) => set({ newRoleOpen: open }),
}));
