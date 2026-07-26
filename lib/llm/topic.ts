import "server-only";
import { spawn } from "node:child_process";
import os from "node:os";
import type { ProviderFamily } from "./providers";

const TOPIC_SYSTEM_PROMPT =
  "你是话题概括器。给定一段问答，输出 4-10 个汉字（或英文单词）的精炼话题标签，捕捉这段问答最核心的主题。只输出标签本身，不要引号、句号、解释、emoji。";

// codex exec 冷启动 + 默认模型加载全套 skills，实测 ~8s——8s 线会恰好掐死它。
const TIMEOUT_MS = 8000;
const CODEX_TIMEOUT_MS = 20000;

// Spawn a short CLI call to summarize a Q+A into a 4-10 char topic. Routed by
// family so a codex-only machine gets labels too（此前硬编码 spawn claude——
// codex 会话在没装 claude 的机器上永远只有问题前缀兜底）。Best-effort: any
// failure (timeout, non-zero exit, empty output) returns null and the caller
// falls back to question prefix in the UI.
export async function generateTopicLabel(
  question: string,
  response: string,
  family: ProviderFamily = "claude",
): Promise<string | null> {
  if (!question.trim()) return null;
  const truncatedResponse = response.slice(0, 800);
  const prompt = `问：${question}\n\n答：${truncatedResponse}\n\n话题标签：`;

  const cmd =
    family === "codex"
      ? {
          bin: "codex",
          // codex 无 --system-prompt → inline；--json 因为 plain 输出混 banner。
          // 模型用本机默认（不硬编码 slug，别机器的 models_cache 未必有），
          // effort 压 low —— 打标签不需要思考。
          args: [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "-c",
            "model_reasoning_effort=low",
            `${TOPIC_SYSTEM_PROMPT}\n\n---\n\n${prompt}`,
          ],
        }
      : {
          bin: "claude",
          args: [
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
        };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const proc = spawn(cmd.bin, cmd.args, {
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(null);
    }, family === "codex" ? CODEX_TIMEOUT_MS : TIMEOUT_MS);

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const stdout = Buffer.concat(chunks).toString("utf8");
      const raw =
        family === "codex" ? extractCodexText(stdout) : stdout.trim();
      // Trim quotes / trailing punctuation that the model occasionally adds
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

// codex --json：agent_message 在 item.completed 整段到达，取最后一条。
function extractCodexText(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (
        (obj.type === "item.completed" || obj.type === "item.updated") &&
        obj.item?.type === "agent_message" &&
        typeof obj.item.text === "string"
      ) {
        text = obj.item.text;
      }
    } catch {
      // banner / non-json line — skip
    }
  }
  return text.trim();
}
