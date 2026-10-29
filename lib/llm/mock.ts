import type { LLMProvider, StreamEvent, StreamRequest } from "./types";
import { pickResponse } from "./mock-responses";
import { NODE_REF_LEAD } from "@/lib/node-refs";

const CHUNK_MIN = 4;
const CHUNK_MAX = 10;
const CHUNK_DELAY_MS = 22;

export const mockProvider: LLMProvider = {
  async *stream({
    history,
    question,
    parentAnchor,
    signal,
  }: StreamRequest): AsyncGenerator<StreamEvent> {
    // `@` 引用的上下文块（lib/node-refs.ts）不参与关键词匹配，免得被引用内容
    // 触发预设回答；回答末尾回显收到了哪些引用，供隔离实例 / e2e 验证注入链路。
    const refAt = question.indexOf(NODE_REF_LEAD);
    const ownQuestion = refAt >= 0 ? question.slice(0, refAt) : question;
    const refTitles = [...question.matchAll(/<referenced_node [^>]*title="([^"]*)"/g)].map((m) => m[1]);
    const response =
      pickResponse(ownQuestion, history, parentAnchor) +
      (refTitles.length > 0
        ? `\n\n（mock：本轮收到 ${refTitles.length} 个引用节点上下文：${refTitles.join("、")}）`
        : "");
    let outputChars = 0;

    for (const chunk of chunkText(response, CHUNK_MIN, CHUNK_MAX)) {
      if (signal?.aborted) {
        yield { type: "error", message: "aborted" };
        return;
      }
      await sleep(CHUNK_DELAY_MS);
      yield { type: "delta", text: chunk };
      outputChars += chunk.length;
    }

    const inputChars =
      question.length +
      history.reduce((n, m) => n + m.content.length, 0) +
      (parentAnchor?.selectedText.length ?? 0);

    yield {
      type: "done",
      usage: {
        input: Math.ceil(inputChars / 4),
        output: Math.ceil(outputChars / 4),
        cacheRead: 0,
        cacheCreation: 0,
      },
    };
  },
};

function chunkText(text: string, min: number, max: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const len = min + Math.floor(Math.random() * (max - min + 1));
    chunks.push(text.slice(i, i + len));
    i += len;
  }
  return chunks;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
