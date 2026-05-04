import "server-only";
import { spawn } from "node:child_process";
import os from "node:os";

const TOPIC_SYSTEM_PROMPT =
  "你是话题概括器。给定一段问答，输出 4-10 个汉字（或英文单词）的精炼话题标签，捕捉这段问答最核心的主题。只输出标签本身，不要引号、句号、解释、emoji。";

const TIMEOUT_MS = 8000;

// Spawn a short claude haiku call to summarize a Q+A into a 4-10 char topic.
// Best-effort: any failure (timeout, non-zero exit, empty output) returns
// null and the caller falls back to question prefix in the UI.
export async function generateTopicLabel(
  question: string,
  response: string,
): Promise<string | null> {
  if (!question.trim()) return null;
  const truncatedResponse = response.slice(0, 800);
  const prompt = `问：${question}\n\n答：${truncatedResponse}\n\n话题标签：`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const proc = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "text",
        "--no-session-persistence",
        "--tools",
        "",
        "--system-prompt",
        TOPIC_SYSTEM_PROMPT,
        "--model",
        "haiku",
      ],
      {
        cwd: os.tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(null);
    }, TIMEOUT_MS);

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      // Trim quotes / trailing punctuation that haiku occasionally adds
      // despite the system prompt telling it not to.
      const cleaned = raw
        .replace(/^["「『'']/, "")
        .replace(/["」』''.。]$/, "")
        .replace(/\s+/g, " ")
        .trim();
      // Cap to ~12 chars so layout never breaks even if the model ignored
      // the length hint.
      const finalLabel = cleaned.length > 14 ? cleaned.slice(0, 14) : cleaned;
      finish(finalLabel || null);
    });
  });
}
