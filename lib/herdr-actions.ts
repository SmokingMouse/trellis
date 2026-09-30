// 浏览器侧的 Herdr 窗格动作：发按键 / 发文本 / 读屏 / 切焦点。
// 会话内审批卡、/herdr 总览泳道卡、终端抽屉共用这一份，不各写一遍 fetch。
import type { HerdrInputDelivery } from "./herdr-input";

function paneUrl(paneId: string, action: string): string {
  return `/api/herdr/panes/${encodeURIComponent(paneId)}/${action}`;
}

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* keep status text */ }
    throw new Error(message);
  }
  return response;
}

export async function sendHerdrKeys(paneId: string, keys: string[]): Promise<void> {
  await ensureOk(await fetch(paneUrl(paneId, "keys"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  }));
}

export async function sendHerdrInput(paneId: string, text: string): Promise<HerdrInputDelivery> {
  const response = await ensureOk(await fetch(paneUrl(paneId, "input"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }));
  return ((await response.json()) as { result: HerdrInputDelivery }).result;
}

export async function focusHerdrPane(paneId: string): Promise<void> {
  await ensureOk(await fetch(paneUrl(paneId, "focus"), { method: "POST" }));
}

export async function readHerdrPane(paneId: string, lines = 40): Promise<string> {
  const response = await ensureOk(await fetch(`${paneUrl(paneId, "read")}?lines=${lines}`, { cache: "no-store" }));
  return ((await response.json()) as { text?: string }).text ?? "";
}

// 悬停预览的客户端缓存：同一窗格 5 秒内只读一次、并发悬停共用一个请求，
// 不让鼠标在卡片网格上扫一遍就打出一串 socket 读。
const PEEK_TTL_MS = 5_000;
const peekCache = new Map<string, { at: number; text: string }>();
const peekPending = new Map<string, Promise<string>>();

export function cachedHerdrPeek(paneId: string, lines = 8, now = Date.now()): { text: string | null; load: () => Promise<string> } {
  const hit = peekCache.get(paneId);
  const fresh = hit && now - hit.at < PEEK_TTL_MS ? hit.text : null;
  const load = () => {
    if (fresh != null) return Promise.resolve(fresh);
    const running = peekPending.get(paneId);
    if (running) return running;
    const request = readHerdrPane(paneId, lines)
      .then((text) => {
        peekCache.set(paneId, { at: Date.now(), text });
        return text;
      })
      .finally(() => peekPending.delete(paneId));
    peekPending.set(paneId, request);
    return request;
  };
  return { text: hit?.text ?? null, load };
}
