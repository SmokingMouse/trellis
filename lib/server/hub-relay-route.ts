import "server-only";
import { requestHub } from "@/lib/hub-relay-client";

// A 机器本地的 /api/hub/* 路由共用：把请求转给 hub 的 /__gw/relay/*，响应原样回给
// 调用方（trellisctl）。hub 的 4xx 带人话 error（策略拒绝的原因），不改写。

export async function relayToHub(
  method: "GET" | "POST",
  path: `/__gw/relay/${string}`,
  body?: unknown,
): Promise<Response> {
  let res: Response | null;
  try {
    res = await requestHub(method, path, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[trellis/hub] relay ${method} ${path} 失败：${msg}`);
    return Response.json({ error: `连不上 hub：${msg}` }, { status: 502 });
  }
  if (!res) {
    return Response.json(
      {
        error:
          "这台机器没接入 hub：远端机器在设置 → 机器互联粘贴连接串；hub 同机的实例配 TRELLIS_HUB_RELAY_URL（见 lib/hub-relay-client.ts）",
      },
      { status: 503 },
    );
  }
  const text = await res.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* hub 回了非 JSON：多半是旧版网关没有这条中继 */
  }
  if (!j || typeof j !== "object") {
    return Response.json(
      { error: `hub 回了非 JSON（HTTP ${res.status}）—— 网关版本可能还没有 ${path} 这条中继` },
      { status: 502 },
    );
  }
  // hub 的 401 是「本机的中继凭证不对」，不是调用方没登录本机 —— 别让 trellisctl 误报成本机认证闸。
  if (res.status === 401) {
    const reason = (j as { error?: string }).error ?? "unauthorized";
    return Response.json({ error: `hub 拒绝了本机的中继凭证：${reason}` }, { status: 502 });
  }
  return Response.json(j, { status: res.status, headers: { "cache-control": "no-store" } });
}
