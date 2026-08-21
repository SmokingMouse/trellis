import { getAppSetting, setAppSetting } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 服务端 app 级偏好 kv（app_settings 表）的读写口。与 /settings/prefs 那批
// localStorage 偏好的分界：**spawn 路径要读的**才进这里（服务端读不到
// localStorage）。key 白名单制 —— 新偏好先在这里登记。
const ALLOWED_KEYS = new Set(["label_model_claude", "label_model_codex"]);

// GET /api/settings → { settings: { <key>: string | null } }（全白名单键）
export async function GET() {
  const settings: Record<string, string | null> = {};
  for (const key of ALLOWED_KEYS) settings[key] = getAppSetting(key);
  return Response.json({ settings });
}

// PATCH /api/settings { key, value }。value 空/null = 清除回默认。
export async function PATCH(req: Request) {
  let body: { key?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : "";
  if (!ALLOWED_KEYS.has(key)) {
    return Response.json({ error: `unknown setting key: ${key}` }, { status: 400 });
  }
  if (body.value !== null && body.value !== undefined && typeof body.value !== "string") {
    return Response.json({ error: "value must be string | null" }, { status: 400 });
  }
  setAppSetting(key, (body.value as string | null | undefined) ?? null);
  return Response.json({ key, value: getAppSetting(key) });
}
