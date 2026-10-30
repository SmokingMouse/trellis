"use client";
import { create } from "zustand";
import type { NightlyFrequency, RoleChange, RoleNightlyState } from "@/lib/role-changes";
import type {
  RoleBackgroundTask,
  RoleCapabilities,
  RoleCapabilitiesInput,
  RoleRoutine,
  RoleRoutineInput,
} from "@/lib/role-routines";
import type { LarkBot } from "@/lib/lark-types";

// 角色 P2（docs/roles-p2.md A 包）的前端数据：夜间整理状态 / 整理卡提案 / 例行 / 后台任务 / 能力。
// 独立于 roleStore（P1 的角色本体 + 记忆），免得两个包同时改一个 store 文件。
// 失败一律返回错误文案（string），调用方 toast；成功返回数据或 null。

type ChangeAction = "accept" | "reject" | "revert";

type State = {
  nightly: Record<string, RoleNightlyState>;
  /** 整理卡（系统节点 id）→ 那张卡上的提案 */
  changesByNode: Record<string, RoleChange[]>;
  /** 角色 id → 整理历史（已接受 / 已撤销） */
  history: Record<string, RoleChange[]>;
  routines: Record<string, RoleRoutine[]>;
  bgTasks: Record<string, RoleBackgroundTask[]>;
  capabilities: Record<string, RoleCapabilities>;
  /** 全部飞书机器人（渠道 tab / 一览按 agentId 过滤）；null = 还没拉 */
  bots: LarkBot[] | null;
  /** 正在处理的改动 id → 动作 */
  busy: Record<string, ChangeAction | "accept-all">;

  loadNightly: (roleId: string) => Promise<RoleNightlyState | string>;
  setFrequency: (roleId: string, frequency: NightlyFrequency) => Promise<string | null>;
  runNightly: (roleId: string) => Promise<{ status: string; error?: string; reason?: string } | string>;
  loadChanges: (roleId: string, nodeId: string) => Promise<void>;
  loadHistory: (roleId: string) => Promise<void>;
  act: (roleId: string, change: RoleChange, action: ChangeAction) => Promise<string | null>;
  acceptAll: (roleId: string, nodeId: string) => Promise<string | null>;
  loadRoutines: (roleId: string) => Promise<void>;
  createRoutine: (roleId: string, input: RoleRoutineInput) => Promise<RoleRoutine | string>;
  updateRoutine: (roleId: string, taskId: string, patch: Partial<RoleRoutineInput>) => Promise<string | null>;
  deleteRoutine: (roleId: string, taskId: string) => Promise<string | null>;
  runRoutine: (taskId: string) => Promise<string | null>;
  loadBgTasks: (roleId: string) => Promise<void>;
  loadCapabilities: (roleId: string) => Promise<void>;
  saveCapabilities: (roleId: string, input: RoleCapabilitiesInput) => Promise<string | null>;
  deleteRoleSkill: (roleId: string, name: string) => Promise<string | null>;
  loadBots: () => Promise<void>;
  /** 把机器人绑到角色（roleId）或解绑（null）。创建机器人仍在 /settings/bots。 */
  bindBot: (botId: string, roleId: string | null) => Promise<string | null>;
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

const base = (roleId: string) => `/api/roles/${encodeURIComponent(roleId)}`;

function replaceChange(list: RoleChange[] | undefined, c: RoleChange): RoleChange[] | undefined {
  return list?.map((x) => (x.id === c.id ? c : x));
}

export const useRoleExtrasStore = create<State>((set, get) => ({
  nightly: {},
  changesByNode: {},
  history: {},
  routines: {},
  bgTasks: {},
  capabilities: {},
  bots: null,
  busy: {},

  loadNightly: async (roleId) => {
    const r = await call<RoleNightlyState>(`${base(roleId)}/nightly`);
    if (typeof r !== "string") set((s) => ({ nightly: { ...s.nightly, [roleId]: r } }));
    return r;
  },

  setFrequency: async (roleId, frequency) => {
    const prev = get().nightly[roleId];
    // 乐观更新：开关即时翻过去，失败再翻回来
    if (prev) set((s) => ({ nightly: { ...s.nightly, [roleId]: { ...prev, frequency } } }));
    const r = await call<RoleNightlyState>(`${base(roleId)}/nightly`, {
      method: "PATCH",
      body: JSON.stringify({ frequency }),
    });
    if (typeof r === "string") {
      if (prev) set((s) => ({ nightly: { ...s.nightly, [roleId]: prev } }));
      return r;
    }
    set((s) => ({ nightly: { ...s.nightly, [roleId]: r } }));
    return null;
  },

  runNightly: async (roleId) => {
    const prev = get().nightly[roleId];
    if (prev) set((s) => ({ nightly: { ...s.nightly, [roleId]: { ...prev, running: true } } }));
    const r = await call<{ result: { status: string; error?: string; reason?: string }; state: RoleNightlyState }>(
      `${base(roleId)}/nightly`,
      { method: "POST" },
    );
    if (typeof r === "string") {
      if (prev) set((s) => ({ nightly: { ...s.nightly, [roleId]: { ...prev, running: false } } }));
      return r;
    }
    set((s) => ({ nightly: { ...s.nightly, [roleId]: r.state } }));
    return r.result;
  },

  loadChanges: async (roleId, nodeId) => {
    const r = await call<{ changes: RoleChange[] }>(`${base(roleId)}/changes?nodeId=${encodeURIComponent(nodeId)}`);
    if (typeof r !== "string") set((s) => ({ changesByNode: { ...s.changesByNode, [nodeId]: r.changes } }));
  },

  loadHistory: async (roleId) => {
    const r = await call<{ changes: RoleChange[] }>(`${base(roleId)}/changes?decided=1&limit=50`);
    if (typeof r !== "string") set((s) => ({ history: { ...s.history, [roleId]: r.changes } }));
  },

  act: async (roleId, change, action) => {
    set((s) => ({ busy: { ...s.busy, [change.id]: action } }));
    const r = await call<{ change: RoleChange }>(`${base(roleId)}/changes/${encodeURIComponent(change.id)}`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    set((s) => {
      const busy = { ...s.busy };
      delete busy[change.id];
      if (typeof r === "string") return { busy };
      const nodeId = r.change.nodeId;
      return {
        busy,
        changesByNode: nodeId
          ? { ...s.changesByNode, [nodeId]: replaceChange(s.changesByNode[nodeId], r.change) ?? [r.change] }
          : s.changesByNode,
        history: { ...s.history, [roleId]: replaceChange(s.history[roleId], r.change) ?? [] },
      };
    });
    if (typeof r === "string") return r;
    return r.change.status === "failed" ? (r.change.error ?? "应用失败") : null;
  },

  acceptAll: async (roleId, nodeId) => {
    set((s) => ({ busy: { ...s.busy, [nodeId]: "accept-all" } }));
    const r = await call<{ changes: RoleChange[] }>(`${base(roleId)}/changes`, {
      method: "POST",
      body: JSON.stringify({ action: "accept-all", nodeId }),
    });
    set((s) => {
      const busy = { ...s.busy };
      delete busy[nodeId];
      return typeof r === "string" ? { busy } : { busy, changesByNode: { ...s.changesByNode, [nodeId]: r.changes } };
    });
    if (typeof r === "string") return r;
    const failed = r.changes.filter((c) => c.status === "failed");
    return failed.length ? `${failed.length} 条没能应用：${failed[0].error ?? ""}` : null;
  },

  loadRoutines: async (roleId) => {
    const r = await call<{ routines: RoleRoutine[] }>(`${base(roleId)}/routines`);
    if (typeof r !== "string") set((s) => ({ routines: { ...s.routines, [roleId]: r.routines } }));
  },

  createRoutine: async (roleId, input) => {
    const r = await call<{ routine: RoleRoutine }>(`${base(roleId)}/routines`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (typeof r === "string") return r;
    set((s) => ({ routines: { ...s.routines, [roleId]: [...(s.routines[roleId] ?? []), r.routine] } }));
    return r.routine;
  },

  updateRoutine: async (roleId, taskId, patch) => {
    const prev = get().routines[roleId];
    if (prev && patch.enabled !== undefined) {
      set((s) => ({
        routines: { ...s.routines, [roleId]: prev.map((x) => (x.taskId === taskId ? { ...x, enabled: patch.enabled! } : x)) },
      }));
    }
    const r = await call<{ routine: RoleRoutine }>(`${base(roleId)}/routines/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (typeof r === "string") {
      if (prev) set((s) => ({ routines: { ...s.routines, [roleId]: prev } }));
      return r;
    }
    set((s) => ({
      routines: {
        ...s.routines,
        [roleId]: (s.routines[roleId] ?? []).map((x) => (x.taskId === taskId ? r.routine : x)),
      },
    }));
    return null;
  },

  deleteRoutine: async (roleId, taskId) => {
    const r = await call<{ ok: true }>(`${base(roleId)}/routines/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    if (typeof r === "string") return r;
    set((s) => ({ routines: { ...s.routines, [roleId]: (s.routines[roleId] ?? []).filter((x) => x.taskId !== taskId) } }));
    return null;
  },

  runRoutine: async (taskId) => {
    const r = await call<{ ok?: boolean; reason?: string }>(`/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    return typeof r === "string" ? r : null;
  },

  loadBgTasks: async (roleId) => {
    const r = await call<{ tasks: RoleBackgroundTask[] }>(`${base(roleId)}/background-tasks?limit=20`);
    if (typeof r !== "string") set((s) => ({ bgTasks: { ...s.bgTasks, [roleId]: r.tasks } }));
  },

  loadCapabilities: async (roleId) => {
    const r = await call<RoleCapabilities>(`${base(roleId)}/capabilities`);
    if (typeof r !== "string") set((s) => ({ capabilities: { ...s.capabilities, [roleId]: r } }));
  },

  saveCapabilities: async (roleId, input) => {
    const r = await call<RoleCapabilities>(`${base(roleId)}/capabilities`, { method: "PUT", body: JSON.stringify(input) });
    if (typeof r === "string") return r;
    set((s) => ({ capabilities: { ...s.capabilities, [roleId]: r } }));
    return null;
  },

  loadBots: async () => {
    const r = await call<{ bots: LarkBot[] }>("/api/lark-bots");
    if (typeof r !== "string") set({ bots: r.bots });
  },

  bindBot: async (botId, roleId) => {
    const r = await call<{ bot: LarkBot }>(`/api/lark-bots/${encodeURIComponent(botId)}`, {
      method: "PATCH",
      body: JSON.stringify({ agentId: roleId }),
    });
    if (typeof r === "string") return r;
    set((s) => ({ bots: s.bots?.map((b) => (b.id === botId ? r.bot : b)) ?? null }));
    return null;
  },

  deleteRoleSkill: async (roleId, name) => {
    const r = await call<{ ok: true }>(`${base(roleId)}/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (typeof r === "string") return r;
    await get().loadCapabilities(roleId);
    return null;
  },
}));
