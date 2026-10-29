// node 接入 hub 的配置：连接串格式 + 本机配置文件。hub 侧（gateway）、node 侧
// （server.ts / Next API / CLI）共用，所以这里只依赖 node: 内置模块。
//
// 配置来源优先级：三个环境变量齐全 > ~/.trellis/hub-node.json。环境变量给
// systemd / plist 里写死的部署用；文件给「设置页粘贴连接串」用——server.ts
// 轮询这个文件，改了就重连，不需要重启服务。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type HubNodeConfig = { hubURL: string; nodeName: string; nodeToken: string };

export type ConnectionString = { hub: string; name: string; ticket: string };

const PREFIX = "trellis://v1/";

export function encodeConnectionString(c: ConnectionString): string {
  return PREFIX + Buffer.from(JSON.stringify(c)).toString("base64url");
}

/** 解析连接串；格式不对返回 null（调用方给人话错误，不把原串回显到日志）。 */
export function parseConnectionString(raw: string): ConnectionString | null {
  const s = raw.trim();
  if (!s.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(Buffer.from(s.slice(PREFIX.length), "base64url").toString("utf8")) as Partial<ConnectionString>;
    if (typeof v.hub !== "string" || typeof v.name !== "string" || typeof v.ticket !== "string") return null;
    const hub = new URL(v.hub);
    if (hub.protocol !== "https:" && hub.protocol !== "http:") return null;
    if (!/^[a-z0-9-]{1,32}$/.test(v.name) || !v.ticket) return null;
    return { hub: hub.origin, name: v.name, ticket: v.ticket };
  } catch {
    return null;
  }
}

export function hubNodeFile(): string {
  return process.env.TRELLIS_HUB_NODE_FILE || path.join(os.homedir(), ".trellis", "hub-node.json");
}

export function readHubNodeFile(file = hubNodeFile()): HubNodeConfig | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HubNodeConfig>;
    if (typeof v.hubURL !== "string" || typeof v.nodeName !== "string" || typeof v.nodeToken !== "string") return null;
    if (!v.hubURL || !v.nodeName || !v.nodeToken) return null;
    return { hubURL: v.hubURL, nodeName: v.nodeName, nodeToken: v.nodeToken };
  } catch {
    return null;
  }
}

/** 原子写入（先写临时文件再 rename），权限 0600——里面是长期 token。 */
export function writeHubNodeFile(cfg: HubNodeConfig, file = hubNodeFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeHubNodeFile(file = hubNodeFile()): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function envHubNodeConfig(env: NodeJS.ProcessEnv = process.env): HubNodeConfig | null {
  const { TRELLIS_HUB_URL: hubURL, TRELLIS_NODE_NAME: nodeName, TRELLIS_NODE_TOKEN: nodeToken } = env;
  return hubURL && nodeName && nodeToken ? { hubURL, nodeName, nodeToken } : null;
}

export type ResolvedHubNodeConfig = (HubNodeConfig & { source: "env" | "file" }) | null;

export function resolveHubNodeConfig(): ResolvedHubNodeConfig {
  const env = envHubNodeConfig();
  if (env) return { ...env, source: "env" };
  const file = readHubNodeFile();
  return file ? { ...file, source: "file" } : null;
}

/**
 * 用连接串里的一次性票据向 hub 换长期 token。出站走 HTTPS_PROXY（bun 的 fetch
 * 自动读代理环境变量）。失败抛出带人话的 Error。
 */
export async function redeemConnectionString(conn: ConnectionString): Promise<HubNodeConfig> {
  let res: Response;
  try {
    res = await fetch(`${conn.hub}/__gw/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: conn.ticket, name: conn.name }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`连不上 hub ${conn.hub}：${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string; name?: string; error?: string };
  if (!res.ok || !body.token) {
    throw new Error(
      res.status === 410 || res.status === 404
        ? "连接串已过期或已被使用，请在 hub 上重新生成"
        : body.error || `hub 拒绝了配对（HTTP ${res.status}）`,
    );
  }
  return { hubURL: conn.hub, nodeName: body.name || conn.name, nodeToken: body.token };
}
