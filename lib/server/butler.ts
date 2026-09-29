import "server-only";
import { listAgents } from "@/lib/server/agents";
import { listTasks, listTriggers, listRuns } from "@/lib/server/tasks";
import { readModelConfigState } from "@/lib/server/model-config";
import { getAuthHealth } from "@/lib/server/auth-health";
import { listLarkBots } from "@/lib/server/lark/store";
import { updateStatus } from "@/lib/server/update";
import { getDB } from "@/lib/server/sqlite";
import {
  BUTLER_AGENT_ID,
  type ButlerOverview,
  type ButlerSection,
} from "@/lib/butler";

async function section<T>(fn: () => T | Promise<T>): Promise<ButlerSection<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const FAILED = new Set(["error", "timeout", "aborted"]);

// 只读汇总：全部走 lib/server 的现成函数，不绕 HTTP、不新增任何写路径。
export async function butlerOverview(): Promise<ButlerOverview> {
  const [agents, tasks, models, auth, bots, version] = await Promise.all([
    section(() => {
      const all = listAgents();
      return {
        total: all.length,
        disabled: all.filter((a) => !a.enabled).length,
        custom: all.filter((a) => !a.builtin).length,
      };
    }),
    section(() => {
      const all = listTasks();
      let scheduled = 0;
      let running = 0;
      const failing: { id: string; name: string; status: string; error: string | null }[] = [];
      for (const t of all) {
        if (t.enabled && listTriggers(t.id).length > 0) scheduled++;
        const last = listRuns(t.id, 1)[0];
        if (!last) continue;
        if (last.status === "running" || last.status === "pending") running++;
        if (FAILED.has(last.status)) {
          failing.push({ id: t.id, name: t.name, status: last.status, error: last.errorMessage });
        }
      }
      return {
        total: all.length,
        enabled: all.filter((t) => t.enabled).length,
        scheduled,
        running,
        failing,
      };
    }),
    section(() => {
      const s = readModelConfigState();
      return {
        defaultModel: s.defaultModel,
        providers: s.providers.length,
        missingKey: s.providers.filter((p) => !p.hasKey).map((p) => p.name),
      };
    }),
    section(async () => {
      const h = await getAuthHealth();
      return {
        clis: (["claude", "codex"] as const).map((name) => ({
          name,
          installed: h[name].installed,
          loggedIn: h[name].loggedIn,
          refreshExpiresAt: h[name].refreshExpiresAt,
          warnings: h[name].warnings,
          errors: h[name].errors,
        })),
      };
    }),
    section(() => {
      const all = listLarkBots();
      return {
        total: all.length,
        enabled: all.filter((b) => b.enabled).length,
        errored: all
          .filter((b) => b.enabled && b.lastError)
          .map((b) => ({ id: b.id, name: b.name, error: b.lastError as string })),
      };
    }),
    section(() => {
      const s = updateStatus(false);
      return {
        sha: s.current?.sha ?? null,
        builtAt: s.current?.builtAt ?? null,
        behind: s.behind,
        deployPhase: s.deploy?.phase ?? null,
      };
    }),
  ]);
  return { agents, tasks, models, auth, bots, version, generatedAt: Date.now() };
}

// 最近一条管家会话（未归档）。没有就返回 null —— 会话连同根节点一起建，
// 不存在「空会话」，所以新开由前端走普通 streamRoot 并带上管家 agentId。
export function latestButlerSessionId(): string | null {
  const row = getDB()
    .prepare(
      `SELECT id FROM sessions
        WHERE agent_id = ? AND archived = 0 AND kind = 'user'
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(BUTLER_AGENT_ID) as { id: string } | undefined;
  return row?.id ?? null;
}
