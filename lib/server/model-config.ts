import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument, Document } from "yaml";
import {
  resolveConfigPath,
  clearEndpointsCache,
  loadEndpoints,
} from "@smokingmouse/llm";

// In-app editor for the SAME endpoints.yaml every sm-toolkit consumer reads —
// trellis adds no second config store. Editing strategy: yaml Document API,
// so hand-written comments/ordering elsewhere in the file survive; only the
// touched provider block is regenerated. API keys never enter the yaml (or
// the DB): they go into the env_file (created at ~/.config/sm/.env, 0600)
// referenced by the yaml's existing `env_file` mechanism, and are pushed into
// process.env immediately so a save is live without a server restart
// (clearEndpointsCache makes the next loadEndpoints re-read disk).
//
// Redaction contract: nothing returned from this module ever contains a key
// value — only hasKey booleans. Routes must keep it that way.

export type ModelConfigProvider = {
  name: string;
  anthropic_url?: string;
  openai_url?: string;
  api_key_env: string;
  models: string[];
  hasKey: boolean;
  /** No URL override at all — ambient CLI login, no key needed. */
  native: boolean;
};

export type ModelConfigState = {
  /** The yaml file being edited (may not exist yet). */
  path: string;
  exists: boolean;
  envFile: string | null;
  defaultModel: string | null;
  providers: ModelConfigProvider[];
};

export type UpsertProviderInput = {
  name: string;
  anthropic_url?: string;
  openai_url?: string;
  /** Env var name; defaults to <NAME>_API_KEY. */
  api_key_env?: string;
  /** Raw key value — written to env_file + process.env, never echoed back. */
  apiKey?: string;
  models: string[];
};

const DEFAULT_ENV_FILE = "~/.config/sm/.env";

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function configPath(): string {
  return resolveConfigPath();
}

function readDoc(p: string): Document | null {
  if (!fs.existsSync(p)) return null;
  return parseDocument(fs.readFileSync(p, "utf8"));
}

export function readModelConfigState(): ModelConfigState {
  const p = configPath();
  const doc = readDoc(p);
  if (!doc) {
    return { path: p, exists: false, envFile: null, defaultModel: null, providers: [] };
  }
  const js = doc.toJS() as {
    providers?: Record<
      string,
      {
        api_key_env?: string;
        anthropic_url?: string;
        openai_url?: string;
        models?: unknown[];
      }
    >;
    default?: string;
    env_file?: string;
  };
  const providers: ModelConfigProvider[] = Object.entries(js.providers ?? {}).map(
    ([name, prov]) => {
      const apiKeyEnv = prov?.api_key_env ?? defaultKeyEnv(name);
      const native = !prov?.anthropic_url && !prov?.openai_url;
      return {
        name,
        anthropic_url: prov?.anthropic_url,
        openai_url: prov?.openai_url,
        api_key_env: apiKeyEnv,
        models: (prov?.models ?? []).map(String),
        hasKey: native || !!process.env[apiKeyEnv],
        native,
      };
    },
  );
  return {
    path: p,
    exists: true,
    envFile: js.env_file ?? null,
    defaultModel: js.default ?? null,
    providers,
  };
}

function defaultKeyEnv(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

export function upsertProvider(input: UpsertProviderInput): ModelConfigState {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) throw new Error("provider 名只能是字母/数字/-/_，且以字母或数字开头");
  const models = input.models.map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("至少填一个模型名");
  const anthropicUrl = input.anthropic_url?.trim() || undefined;
  const openaiUrl = input.openai_url?.trim() || undefined;
  for (const u of [anthropicUrl, openaiUrl]) {
    if (u && !/^https?:\/\//.test(u)) throw new Error(`URL 需以 http(s):// 开头：${u}`);
  }
  const apiKeyEnv = input.api_key_env?.trim() || defaultKeyEnv(name);
  if (!ENV_RE.test(apiKeyEnv)) throw new Error("api_key_env 需是合法环境变量名（大写字母/数字/_）");

  const p = configPath();
  let doc = readDoc(p);
  if (!doc) {
    doc = new Document({});
    doc.commentBefore =
      " endpoints.yaml — created by trellis 模型配置 UI\n" +
      " search order: $SM_ENDPOINTS_PATH → ~/.config/sm/endpoints.yaml → ~/.claude/global/endpoints.yaml";
  }

  // Provider block is regenerated wholesale (comments inside it are lost;
  // everything else in the file is preserved by the Document API).
  const block: Record<string, unknown> = { api_key_env: apiKeyEnv };
  if (anthropicUrl) block.anthropic_url = anthropicUrl;
  if (openaiUrl) block.openai_url = openaiUrl;
  block.models = models;
  // Preserve an existing hand-written claude: settings block on this provider.
  const existingClaude = doc.getIn(["providers", name, "claude"], true);
  doc.setIn(["providers", name], doc.createNode(block));
  if (existingClaude !== undefined) {
    doc.setIn(["providers", name, "claude"], existingClaude);
  }

  // loadEndpoints hard-requires a `default` field — seed one if absent.
  if (!doc.get("default")) doc.set("default", models[0]);

  // Key handling: env_file mechanism, never the yaml itself.
  if (input.apiKey && input.apiKey.trim()) {
    let envFile = doc.get("env_file") as string | undefined;
    if (!envFile) {
      envFile = DEFAULT_ENV_FILE;
      doc.set("env_file", envFile);
    }
    writeEnvVar(expandHome(envFile), apiKeyEnv, input.apiKey.trim());
    // Hot-apply: loadEnvFile never overrides existing process.env values, so
    // a rotated key must be pushed directly.
    process.env[apiKeyEnv] = input.apiKey.trim();
  }

  writeConfig(p, doc);
  return readModelConfigState();
}

export function setDefaultModel(defaultModel: string): ModelConfigState {
  const model = defaultModel.trim();
  if (!model) throw new Error("默认模型名不能为空");
  const p = configPath();
  let doc = readDoc(p);
  if (!doc) {
    doc = new Document({});
    doc.commentBefore =
      " endpoints.yaml — created by trellis 模型配置 UI\n" +
      " search order: $SM_ENDPOINTS_PATH → ~/.config/sm/endpoints.yaml → ~/.claude/global/endpoints.yaml";
  }
  doc.set("default", model);
  writeConfig(p, doc);
  return readModelConfigState();
}

export function deleteProvider(name: string): ModelConfigState {
  const p = configPath();
  const doc = readDoc(p);
  if (!doc) throw new Error("endpoints.yaml 不存在");
  if (doc.getIn(["providers", name]) === undefined) throw new Error(`provider "${name}" 不存在`);
  const before = doc.toJS() as { providers?: Record<string, { models?: unknown[] }> };
  const removedModels = new Set(
    (before.providers?.[name]?.models ?? []).map(String),
  );
  doc.deleteIn(["providers", name]);

  // Keep `default` resolvable if it pointed into the deleted provider.
  const def = doc.get("default") as string | undefined;
  if (def && removedModels.has(def)) {
    const rest = doc.toJS() as { providers?: Record<string, { models?: string[] }> };
    const firstModel = Object.values(rest.providers ?? {}).flatMap((pr) => pr.models ?? [])[0];
    if (firstModel) doc.set("default", firstModel);
  }
  // The key stays in the env_file — harmless, and re-adding the provider
  // picks it right back up.

  writeConfig(p, doc);
  return readModelConfigState();
}

function writeConfig(p: string, doc: Document): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, doc.toString(), "utf8");
  clearEndpointsCache();
  // Re-parse eagerly so a broken write surfaces here (500 with a message)
  // instead of as a mysterious picker fallback later.
  loadEndpoints(p);
}

function writeEnvVar(envPath: string, key: string, value: string): void {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8").split("\n")
    : [];
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry;
  else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(entry);
  }
  fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(envPath, 0o600); // writeFileSync mode only applies on create
}
