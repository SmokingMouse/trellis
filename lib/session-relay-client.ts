// 会话接力的浏览器侧流程：经 hub 的 /__gw/via 通道，从当前机器导出、往目标机器导入。
// 两步都走 via（而不是同源直连当前机器）：导出必须经过网关的 shareOut 外流闸。
import { goHref, viaFetch } from "./gw-client";
import type { RelayFile } from "./session-relay";

export type RelayStep = "export" | "import";

export class RelayClientError extends Error {
  constructor(
    public step: RelayStep,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelayClientError";
  }
}

export type RelayOutcome = {
  sessionId: string;
  path: string;
  title: string;
  mode: "chat" | "project";
  /** 整页跳到目标机器上的新会话。 */
  openHref: string;
};

async function errorText(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data?.error === "string") return data.error;
  } catch {
    /* 非 JSON（网关 502 页等） */
  }
  return `HTTP ${res.status}`;
}

export async function relaySession(args: {
  from: string;
  to: string;
  sessionId: string;
  /** 接力到哪个叶节点为止；null = 会话里最近的节点。 */
  nodeId: string | null;
  /** 目标机器上的工作区绝对路径；null = 以纯对话导入。 */
  workspacePath: string | null;
}): Promise<RelayOutcome> {
  const q = args.nodeId ? `?nodeId=${encodeURIComponent(args.nodeId)}` : "";
  let exp: Response;
  try {
    exp = await viaFetch(args.from, `/api/export/session/${encodeURIComponent(args.sessionId)}${q}`, {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    throw new RelayClientError("export", 0, `连不上 ${args.from}（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!exp.ok) throw new RelayClientError("export", exp.status, await errorText(exp));
  const file = (await exp.json()) as RelayFile;

  let imp: Response;
  try {
    imp = await viaFetch(args.to, "/api/import/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ file, from: args.from, workspacePath: args.workspacePath }),
    });
  } catch (e) {
    throw new RelayClientError("import", 0, `连不上 ${args.to}（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (!imp.ok) throw new RelayClientError("import", imp.status, await errorText(imp));
  const out = (await imp.json()) as Omit<RelayOutcome, "openHref">;
  return { ...out, openHref: goHref(args.to, out.path) };
}

export type RemoteWorkspace = { path: string; shortName: string };

/** 目标机器上最近用过的工作区（给「以 project 模式接着干」选目录）；拿不到返回 []。 */
export async function fetchRemoteWorkspaces(node: string): Promise<RemoteWorkspace[]> {
  try {
    const res = await viaFetch(node, "/api/workspaces/recent", { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as { workspaces?: unknown };
    if (!Array.isArray(data.workspaces)) return [];
    return data.workspaces.filter(
      (w): w is RemoteWorkspace =>
        !!w && typeof (w as RemoteWorkspace).path === "string" && typeof (w as RemoteWorkspace).shortName === "string",
    );
  } catch {
    return [];
  }
}
