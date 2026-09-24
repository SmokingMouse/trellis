import { CARD_MAX_BYTES, type FeishuCardV2 } from "./card";

/**
 * 飞书出站只发 agent 的「最终答复」。
 *
 * run-bus 把「text → 工具/思考 → text」的段落首尾相连存进 response，finalStart 标出最后一次
 * 结构性中断之后的起点（见 lib/types.ts:ChatNode.finalStart）。画布把 [0, finalStart) 折叠成
 * 过程叙述；飞书没有折叠，整段发出去就是一屏「我先查一下…」。所以这里只取最终段；最终段为空
 * （agent 以工具调用收尾、没再说话）时退回整段，不发空消息。
 */
export function larkFinalAnswer(node: { response: string; finalStart?: number | null }): string {
  const start = node.finalStart ?? 0;
  if (start <= 0 || start >= node.response.length) return node.response;
  const tail = node.response.slice(start);
  return tail.trim() ? tail : node.response;
}

/** 定时任务的静默约定：最终答复恰为这个标记时不推送（巡检类任务「没事不出声」）。 */
export const LARK_SILENT_MARK = "[SILENT]";

/** 空答复当不了静默信号——模型几乎总会说点什么；允许首尾空白与包裹的反引号。 */
export function isLarkSilent(text: string): boolean {
  return text.trim().replace(/^`+|`+$/g, "").trim() === LARK_SILENT_MARK;
}

/**
 * 尝试把文本解析为飞书 Card 2.0 JSON（用于任务推送直接发 interactive 卡片）。
 *
 * 门控规则：
 * 1. 允许首尾空白，允许整段被 ```json ... ``` 或 ``` ... ``` 代码块包裹；
 * 2. 解析后必须为普通对象，且 schema === "2.0"，body.elements 为数组；
 * 3. 序列化后的 UTF-8 字节大小不能超过 CARD_MAX_BYTES（24KB），超限时返回 null 走原 markdown 降级路径。
 */
export function parseCardPassthrough(text: string | null | undefined): FeishuCardV2 | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  let raw = trimmed;
  const fenceMatch = raw.match(/^(`{3,}|~{3,})(?:json|JSON)?\s*\n?([\s\S]*?)\n?\1$/);
  if (fenceMatch) {
    raw = fenceMatch[2].trim();
  }

  if (!raw.startsWith("{") || !raw.endsWith("}")) {
    return null;
  }

  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return null;
    }
    if (obj.schema !== "2.0") {
      return null;
    }
    if (!obj.body || typeof obj.body !== "object" || !Array.isArray(obj.body.elements)) {
      return null;
    }
    const jsonStr = JSON.stringify(obj);
    if (Buffer.byteLength(jsonStr, "utf8") > CARD_MAX_BYTES) {
      return null;
    }
    return obj as FeishuCardV2;
  } catch {
    return null;
  }
}

