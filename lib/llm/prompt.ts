import type { ChatMessage } from "./types";

// Format conversation history + new question into a single prompt string.
// Used by providers that take plain prompts (Claude CLI, Codex SDK).
export function buildPrompt(
  history: ChatMessage[],
  question: string,
  parentAnchor?: { selectedText: string } | null,
): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push("以下是之前的对话历史：");
    parts.push("");
    for (const msg of history) {
      const label = msg.role === "user" ? "[USER]" : "[ASSISTANT]";
      parts.push(`${label}:`);
      parts.push(msg.content);
      parts.push("");
    }
  }
  if (parentAnchor?.selectedText) {
    parts.push(
      `用户从上一条回复中选中了这段内容继续追问：「${parentAnchor.selectedText}」`,
    );
    parts.push("");
  }
  parts.push("[USER]:");
  parts.push(question);
  return parts.join("\n");
}

// 历史是否住在将被 resume/fork 的 CLI session 里。true → provider 只发当轮问题
// （buildProjectPrompt）；false → 必须 buildPrompt 折叠 req.history。
// 关键场景：lineage 降级（cli_turn_uuid 缺失 / 前缀截取失败）时 route 置
// claudeSessionId=null 起 fresh session 并折好 DB 历史 —— 没有这道判定，
// project/B-fork 会把历史整个丢掉、模型只收到裸问题（slash command 失忆事故）。
export function historyLivesInCliSession(req: {
  claudeSessionId?: string | null;
  history: ChatMessage[];
}): boolean {
  return Boolean(req.claudeSessionId) || req.history.length === 0;
}

export const DEFAULT_SYSTEM_PROMPT =
  "你是一个简洁、有耐心的助教，回答用户的任何问题。用 markdown 格式（含代码块、列表、加粗等），代码块标注语言。直接给答案，不要客套。不调用任何工具。";
