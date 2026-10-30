// 浏览器侧的 Herdr 窗格动作：发按键 / 发文本 / 读屏 / 切焦点。
// 会话内审批卡、/herdr 总览泳道卡、终端抽屉共用这一份，不各写一遍 fetch。
import type { HerdrInputDelivery, HerdrSendRefusal } from "./herdr-input";

function paneUrl(paneId: string, action: string): string {
  return `/api/herdr/panes/${encodeURIComponent(paneId)}/${action}`;
}

/**
 * 窗格动作失败；发前读屏拒发（409，什么都没打）时带 refusal；
 * 按键 / 作答带的 rev 对不上（409 prompt_changed，什么都没按）时 promptChanged=true。
 * status：HTTP 状态码（网络层失败时为 0），Outbox 据此判断能不能重发。
 */
export class HerdrActionError extends Error {
  constructor(
    message: string,
    readonly refusal?: HerdrSendRefusal,
    readonly status = 0,
    readonly promptChanged = false,
  ) {
    super(message);
    this.name = "HerdrActionError";
  }
}

export const HERDR_PROMPT_CHANGED_MESSAGE = "终端里的对话框变了，这次什么都没按：看清新的再选";

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    let refusal: HerdrSendRefusal | undefined;
    let promptChanged = false;
    try {
      const body = (await response.json()) as { error?: string; delivered?: string; code?: string } & Partial<Omit<HerdrSendRefusal, "code">>;
      if (body.error) message = body.error;
      if (response.status === 409 && body.code === "prompt_changed") {
        promptChanged = true;
        message = HERDR_PROMPT_CHANGED_MESSAGE;
      } else if (response.status === 409 && body.delivered === "none" && body.code) {
        refusal = { code: body.code as HerdrSendRefusal["code"], draft: body.draft, clearable: body.clearable };
      }
    } catch { /* keep status text */ }
    throw new HerdrActionError(message, refusal, response.status, promptChanged);
  }
  return response;
}

/** expectedRev：卡片上对话框的 rev，服务端发键前重读屏幕核对，对不上抛 promptChanged、什么都不按。 */
export async function sendHerdrKeys(paneId: string, keys: string[], expectedRev?: string): Promise<void> {
  await ensureOk(await fetch(paneUrl(paneId, "keys"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(expectedRev !== undefined ? { keys, expectedRev } : { keys }),
  }));
}

/**
 * clearDraft：拒发提示里的单行草稿，用户同意清掉它再发（服务端核对输入框里还是它才清）。
 * clientMsgId：同一条消息重发时带同一个 id，服务端按 TTL 去重、回第一次的结果（Outbox 重发靠它不重复打字）。
 */
export async function sendHerdrInput(
  paneId: string,
  text: string,
  clearDraft?: string,
  clientMsgId: string = newClientMsgId(),
): Promise<HerdrInputDelivery> {
  const response = await ensureOk(await fetch(paneUrl(paneId, "input"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(clearDraft ? { text, clearDraft, clientMsgId } : { text, clientMsgId }),
  }));
  return ((await response.json()) as { result: HerdrInputDelivery }).result;
}

/** 客户端消息 id（client_msg_id）：一条消息一个，重发沿用。 */
export function newClientMsgId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 撤回一条排队中的输入（已送达 / 已失败时服务端回 409 → 抛错）。 */
export async function cancelHerdrInput(paneId: string, inputId: string): Promise<void> {
  await ensureOk(await fetch(`${paneUrl(paneId, "input")}?inputId=${encodeURIComponent(inputId)}`, {
    method: "DELETE",
  }));
}

/** 立即打字进窗格（不排队）；submit 时文字后跟一个 Enter，原子送出。 */
export async function sendHerdrText(paneId: string, text: string, submit = true, expectedRev?: string): Promise<void> {
  await ensureOk(await fetch(paneUrl(paneId, "text"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(expectedRev !== undefined ? { text, submit, expectedRev } : { text, submit }),
  }));
}

/** transcript 待答卡发键前的核对：窗格此刻的 herdr 状态 + jsonl 里仍未完成的 tool_use id。 */
export async function readHerdrPanePending(paneId: string): Promise<{ status: string | null; toolUseId: string | null }> {
  const response = await ensureOk(await fetch(paneUrl(paneId, "pending"), { cache: "no-store" }));
  return (await response.json()) as { status: string | null; toolUseId: string | null };
}

export async function focusHerdrPane(paneId: string): Promise<void> {
  await ensureOk(await fetch(paneUrl(paneId, "focus"), { method: "POST" }));
}

export async function readHerdrPane(
  paneId: string,
  lines = 40,
  format: "text" | "ansi" = "text",
): Promise<string> {
  const response = await ensureOk(
    await fetch(`${paneUrl(paneId, "read")}?lines=${lines}&format=${format}`, { cache: "no-store" }),
  );
  return ((await response.json()) as { text?: string }).text ?? "";
}

export async function createHerdrTab(options?: {
  workspaceId?: string;
  cwd?: string;
  label?: string;
}): Promise<{ tabId: string; paneId: string; workspaceId: string; label: string }> {
  const response = await ensureOk(
    await fetch("/api/herdr/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options ?? {}),
    }),
  );
  const data = (await response.json()) as {
    ok: boolean;
    result: { tabId: string; paneId: string; workspaceId: string; label: string };
  };
  return data.result;
}

/** 向任意窗格（包含纯 shell 窗格）执行命令或按键（终端抽屉使用）。 */
export async function sendHerdrCommand(
  paneId: string,
  command: string,
  keys: string[] = ["Enter"],
): Promise<void> {
  await ensureOk(
    await fetch(paneUrl(paneId, "command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, keys }),
    }),
  );
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
