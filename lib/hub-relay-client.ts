// node → hub 中继的客户端：「我挂在哪个 hub 下、拿什么凭证」+ 发一次 POST。
// 推送中继（/__gw/relay/push）与跨机派活（/__gw/relay/dispatch）共用；hub 侧的验证
// 在 tenancy/gateway/relay-auth.ts（authenticateRelay）。
//
// 两种机器、两种凭证：
// - 远端 node（经隧道接入）：~/.trellis/hub-node.json 或 TRELLIS_HUB_URL 三件套里的
//   hubURL + nodeToken，发 Authorization: Bearer <nodeToken> + x-trellis-node: <名字>。
// - hub 本机的 tenant（例如 Mac mini 上 3088 那个实例）：没有 node token。用它自己的
//   TRELLIS_AUTH_TOKEN（= 网关 tenants/<name>.json 里的 authToken，网关本来就拿它登录
//   这个实例）当凭证；hub 地址由 TRELLIS_HUB_RELAY_URL 给（通常 http://127.0.0.1:3200）。
//   TRELLIS_HUB_RELAY_TENANT 可选：给了就带 x-trellis-tenant，网关不必按 token 反查。
//
// 只依赖 node: 内置模块（经 hub-node-config），Next 服务端与 bun 脚本都能用。

import { resolveHubNodeConfig } from "./hub-node-config";

export type HubRelayTarget = {
  /** hub 的 origin（不带尾斜杠）。 */
  hubURL: string;
  headers: Record<string, string>;
  via: "node" | "tenant";
};

export function hubRelayTarget(env: NodeJS.ProcessEnv = process.env): HubRelayTarget | null {
  if (env.TRELLIS_HUB_RELAY === "off") return null;
  const node = resolveHubNodeConfig();
  if (node) {
    return {
      hubURL: node.hubURL.replace(/\/+$/, ""),
      headers: { authorization: `Bearer ${node.nodeToken}`, "x-trellis-node": node.nodeName },
      via: "node",
    };
  }
  const url = env.TRELLIS_HUB_RELAY_URL;
  const token = env.TRELLIS_AUTH_TOKEN;
  if (!url || !token) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (env.TRELLIS_HUB_RELAY_TENANT) headers["x-trellis-tenant"] = env.TRELLIS_HUB_RELAY_TENANT;
  return { hubURL: url.replace(/\/+$/, ""), headers, via: "tenant" };
}

type Poster = (url: string, init: RequestInit) => Promise<Response>;
type Shared = typeof globalThis & { trellisHubRelayPoster?: Poster };
const shared = globalThis as Shared;

/** 测试注入：替换真实的网络 POST。传 null 恢复。 */
export function setHubRelayPosterForTests(poster: Poster | null): void {
  shared.trellisHubRelayPoster = poster ?? undefined;
}

/** POST JSON 到 hub 的 /__gw/relay/<kind>。没挂 hub 返回 null；网络错误照常抛出。 */
export async function postToHub(
  path: `/__gw/relay/${string}`,
  body: unknown,
  target: HubRelayTarget | null = hubRelayTarget(),
): Promise<Response | null> {
  if (!target) return null;
  const poster = shared.trellisHubRelayPoster ?? ((url, init) => fetch(url, init));
  return poster(`${target.hubURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...target.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

/** 任意方法调 hub 的 /__gw/relay/*（跨机派活要 GET 取结果，且等目标机器建会话比推送久）。
 *  没挂 hub 返回 null；网络错误照常抛出。测试注入同 setHubRelayPosterForTests。 */
export async function requestHub(
  method: "GET" | "POST",
  path: `/__gw/relay/${string}`,
  body?: unknown,
  opts: { timeoutMs?: number; target?: HubRelayTarget | null } = {},
): Promise<Response | null> {
  const target = opts.target === undefined ? hubRelayTarget() : opts.target;
  if (!target) return null;
  const poster = shared.trellisHubRelayPoster ?? ((url, init) => fetch(url, init));
  return poster(`${target.hubURL}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...target.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
  });
}
