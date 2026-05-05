import type { LLMProvider, StreamEvent, StreamRequest } from "./types";
import { pickResponse } from "./mock-responses";

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
    const response = pickResponse(question, history, parentAnchor);
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
