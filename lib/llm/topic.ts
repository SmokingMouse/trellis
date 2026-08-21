import "server-only";
import { spawn } from "node:child_process";
import os from "node:os";
import { getAppSetting } from "@/lib/server/repo";
import type { ProviderFamily } from "./providers";

// 打标/起题模型可在设置页（模型 tab）覆盖，存 app_settings：
//   label_model_claude —— 传给 `claude -p --model <X>`；空 = haiku
//   label_model_codex  —— 传给 `codex exec -c model=<X>`；空 = 本机默认
// 读失败（极早期迁移前调用等）按未配置处理 —— 打标签管道整体 best-effort。
export const LABEL_MODEL_KEYS = {
  claude: "label_model_claude",
  codex: "label_model_codex",
} as const;

function configuredLabelModel(family: "claude" | "codex"): string | null {
  try {
    return getAppSetting(LABEL_MODEL_KEYS[family]);
  } catch {
    return null;
  }
}

const TOPIC_SYSTEM_PROMPT =
  "你是话题概括器。给定一段问答，输出 4-10 个汉字（或英文单词）的精炼话题标签，捕捉这段问答最核心的主题。只输出标签本身，不要引号、句号、解释、emoji。";

// 会话级标题（体验 D）与节点级话题标签共用同一条 spawn 管道，只是提示词
// 与长度上限不同。标题要能在 sidebar 一行内定位这棵树在聊什么。
const TITLE_SYSTEM_PROMPT =
  "你是会话命名器。给定一段对话（可能多轮），输出 6-16 个汉字（或等长英文）的标题，概括这段对话当前聚焦的主题。要具体（提到关键对象/技术名词），不要空泛。只输出标题本身，不要引号、句号、解释、emoji。";

// codex exec 冷启动 + 默认模型加载全套 skills，实测 ~8s——8s 线会恰好掐死它。
// claude 系同样别用 8s：`claude -p --model haiku` 冷启动实测 ~10.6s（热 ~4s），
// 8s 线曾把历史 topic_label 命中率压到 49/493≈10%（S110 实测破案）。15s 上限
// 与 run-bus 的 30s grace window 兼容（topic/title 两钩子并发，取 max 不叠加）。
const TIMEOUT_MS = 15000;
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
  const raw = await runLabelSpawn(TOPIC_SYSTEM_PROMPT, prompt, family);
  if (!raw) return null;
  const cleaned = cleanLabel(raw);
  // Cap to ~12 chars so layout never breaks even if the model ignored
  // the length hint.
  const finalLabel = cleaned.length > 14 ? cleaned.slice(0, 14) : cleaned;
  return finalLabel || null;
}

// 会话自动命名：首答后起题（turns 只有 1 轮），或树长到 8 的倍数时按最近
// 几轮重生成「当前主题」。best-effort 同上 —— 失败返回 null，标题保持原样。
export async function generateSessionTitle(
  turns: { question: string; response: string }[],
  family: ProviderFamily = "claude",
): Promise<string | null> {
  const usable = turns.filter((t) => t.question.trim());
  if (usable.length === 0) return null;
  const convo = usable
    .map(
      (t) =>
        `问：${t.question.slice(0, 300)}\n答：${t.response.slice(0, 500)}`,
    )
    .join("\n\n");
  const prompt = `${convo}\n\n会话标题：`;
  const raw = await runLabelSpawn(TITLE_SYSTEM_PROMPT, prompt, family);
  if (!raw) return null;
  const cleaned = cleanLabel(raw);
  const finalTitle = cleaned.length > 24 ? cleaned.slice(0, 24) : cleaned;
  return finalTitle || null;
}

// Trim quotes / trailing punctuation that the model occasionally adds
// despite the system prompt telling it not to.
function cleanLabel(raw: string): string {
  return raw
    .replace(/^["「『'']/, "")
    .replace(/["」』''.。]$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function runLabelSpawn(
  systemPrompt: string,
  prompt: string,
  family: ProviderFamily,
): Promise<string | null> {
  const cmd =
    family === "codex"
      ? {
          bin: "codex",
          // codex 无 --system-prompt → inline；--json 因为 plain 输出混 banner。
          // 模型默认用本机默认（不硬编码 slug，别机器的 models_cache 未必有），
          // 设置页配了 label_model_codex 才显式传；effort 压 low —— 打标签
          // 不需要思考。
          args: [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "-c",
            "model_reasoning_effort=low",
            ...(() => {
              const m = configuredLabelModel("codex");
              return m ? ["-c", `model=${m}`] : [];
            })(),
            `${systemPrompt}\n\n---\n\n${prompt}`,
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
            systemPrompt,
            "--model",
            // haiku 是官方 alias、任何正常安装都认；网关只路由部分模型的
            // 环境在设置页覆盖。
            configuredLabelModel("claude") ?? "haiku",
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
      finish(raw.trim() || null);
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
