import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument, Document } from "yaml";
import {
  resolveConfigPath,
  clearEndpointsCache,
  loadEndpoints,
  localOverlayPath,
  remoteUrl,
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
// Remote mode ($SM_ENDPOINTS_URL): the resolved path is a pulled cache that the
// next background refresh overwrites, so edits go to the per-machine overlay
// (endpoints.local.yaml, deep-merged over the cache by loadEndpoints) and the
// panel shows the merged view. Overlay edits only affect this machine.
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
  /** Remote mode: `path` is the local overlay, providers are the merged view. */
  remote: boolean;
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

/** models entries are `name` or `{ name, claude?, codex? }` (llm ≥0.7). */
function modelName(m: unknown): string {
  return typeof m === "object" && m !== null ? String((m as { name?: unknown }).name) : String(m);
}

function isRemote(): boolean {
  return !process.env.SM_ENDPOINTS_PATH && !!remoteUrl();
}

/** The file edits are written to. */
function configPath(): string {
  return isRemote() ? localOverlayPath() : resolveConfigPath();
}

function newDoc(): Document {
  const doc = new Document({});
  doc.commentBefore = isRemote()
    ? " endpoints.local.yaml — created by trellis 模型配置 UI\n" +
      " per-machine overlay, deep-merged over the remote $SM_ENDPOINTS_URL config"
    : " endpoints.yaml — created by trellis 模型配置 UI\n" +
      " search order: $SM_ENDPOINTS_PATH → ~/.config/sm/endpoints.yaml → ~/.claude/global/endpoints.yaml";
  return doc;
}

function readDoc(p: string): Document | null {
  if (!fs.existsSync(p)) return null;
  return parseDocument(fs.readFileSync(p, "utf8"));
}

export function readModelConfigState(): ModelConfigState {
  const p = configPath();
  const remote = isRemote();
  let raw: unknown;
  if (remote) {
    clearEndpointsCache();
    raw = loadEndpoints();
  } else {
    const doc = readDoc(p);
    if (!doc) {
      return { path: p, exists: false, remote, envFile: null, defaultModel: null, providers: [] };
    }
    raw = doc.toJS();
  }
  const js = raw as {
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
  // key 真正住在 env_file 里；process.env 只有在某次 LLM 调用触发 loadEnvFile
  // 之后才有。只看 process.env 会在服务刚启动时把所有第三方 provider 误报成缺 key。
  const fileKeys = js.env_file ? envFileKeys(expandHome(js.env_file)) : new Set<string>();
  const providers: ModelConfigProvider[] = Object.entries(js.providers ?? {}).map(
    ([name, prov]) => {
      const apiKeyEnv = prov?.api_key_env ?? defaultKeyEnv(name);
      const native = !prov?.anthropic_url && !prov?.openai_url;
      return {
        name,
        anthropic_url: prov?.anthropic_url,
        openai_url: prov?.openai_url,
        api_key_env: apiKeyEnv,
        models: (prov?.models ?? []).map(modelName),
        hasKey: native || !!process.env[apiKeyEnv] || fileKeys.has(apiKeyEnv),
        native,
      };
    },
  );
  return {
    path: p,
    exists: remote ? fs.existsSync(p) : true,
    remote,
    envFile: js.env_file ?? null,
    defaultModel: js.default ?? null,
    providers,
  };
}

/** env_file 里值非空的变量名（`KEY=v` / `export KEY=v`；注释与空值不算）。只读名字不碰值。 */
export function envFileKeys(file: string): Set<string> {
  const out = new Set<string>();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (v) out.add(m[1]);
  }
  return out;
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
    doc = newDoc();
  }

  // Provider block is regenerated wholesale (comments inside it are lost;
  // everything else in the file is preserved by the Document API).
  const block: Record<string, unknown> = { api_key_env: apiKeyEnv };
  if (anthropicUrl) block.anthropic_url = anthropicUrl;
  if (openaiUrl) block.openai_url = openaiUrl;
  // Keep object-form entries (per-model claude/codex settings) for names
  // that survive the edit; the form itself only deals in names.
  const prevEntries = (doc.getIn(["providers", name, "models"]) as { toJS?: () => unknown } | undefined)?.toJS?.();
  const prevByName = new Map(
    (Array.isArray(prevEntries) ? prevEntries : []).map((m) => [modelName(m), m] as const),
  );
  block.models = models.map((m) => prevByName.get(m) ?? m);
  // Preserve an existing hand-written claude: settings block on this provider.
  const existingClaude = doc.getIn(["providers", name, "claude"], true);
  doc.setIn(["providers", name], doc.createNode(block));
  if (existingClaude !== undefined) {
    doc.setIn(["providers", name, "claude"], existingClaude);
  }

  // loadEndpoints hard-requires a `default` field — seed one if absent
  // (in remote mode the pulled base already carries it).
  if (!isRemote() && !doc.get("default")) doc.set("default", models[0]);

  // Key handling: env_file mechanism, never the yaml itself.
  if (input.apiKey && input.apiKey.trim()) {
    let envFile = (doc.get("env_file") as string | undefined) ?? baseEnvFile();
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
    doc = newDoc();
  }
  doc.set("default", model);
  writeConfig(p, doc);
  return readModelConfigState();
}

export function deleteProvider(name: string): ModelConfigState {
  const p = configPath();
  const doc = readDoc(p);
  const inFile = doc !== null && doc.getIn(["providers", name]) !== undefined;
  if (isRemote()) {
    // deepMerge can't express removal of a base key — only overlay-only
    // providers are deletable here; overlay tweaks on a remote one are dropped.
    const merged = loadEndpoints();
    if (!inFile && !merged.providers[name]) throw new Error(`provider "${name}" 不存在`);
    if (!inFile) throw new Error(`provider "${name}" 来自远端配置，本机无法删除；用 \`llm config edit\` 改远端`);
  }
  if (!doc) throw new Error("endpoints.yaml 不存在");
  if (!inFile) throw new Error(`provider "${name}" 不存在`);
  const before = doc.toJS() as { providers?: Record<string, { models?: unknown[] }> };
  const removedModels = new Set(
    (before.providers?.[name]?.models ?? []).map(modelName),
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

/** env_file declared by the pulled remote base, if any (remote mode only). */
function baseEnvFile(): string | undefined {
  return isRemote() ? loadEndpoints().env_file : undefined;
}

function writeConfig(p: string, doc: Document): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, doc.toString(), "utf8");
  clearEndpointsCache();
  // Re-parse eagerly so a broken write surfaces here (500 with a message)
  // instead of as a mysterious picker fallback later. Remote mode validates
  // the merged result — the overlay alone is not a complete config.
  if (isRemote()) loadEndpoints();
  else loadEndpoints(p);
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

// ── 配置同步（lib/server/config-sync-models.ts）用的原始读写 ────────────────
// 同步要搬的是 provider 整块（含 claude / codex / model_settings 子块），表单那套
// 只认名字的 ModelConfigProvider 不够用。这里只给原始 JS 视图与整块写入；打码 / 还原
// 密钥在 config-sync-models.ts 里做。本文件「不回传 key 值」的契约不变：key 值只住在
// env_file，这里只读 env_file 的变量名、从不读值。

export const PROVIDER_NAME_RE = NAME_RE;
export const API_KEY_ENV_RE = ENV_RE;

export type RawEndpoints = {
  providers: Record<string, Record<string, unknown>>;
  defaultModel: string | null;
  envFile: string | null;
};

/** 当前生效的 providers 原始块（远端模式 = 合并视图）。文件不存在 = 空。 */
export function readRawEndpointsForSync(): RawEndpoints {
  type Js = { providers?: Record<string, Record<string, unknown>>; default?: string; env_file?: string };
  let js: Js;
  if (isRemote()) {
    clearEndpointsCache();
    js = loadEndpoints() as unknown as Js;
  } else {
    js = (readDoc(configPath())?.toJS() ?? {}) as Js;
  }
  return {
    providers: js.providers ?? {},
    defaultModel: js.default ?? null,
    envFile: js.env_file ?? null,
  };
}

/** 目标机器上这个 api_key_env 有没有值（process.env 或 env_file 里非空）。只看名字。 */
export function apiKeyPresent(apiKeyEnv: string, envFile: string | null): boolean {
  if (process.env[apiKeyEnv]) return true;
  return envFile ? envFileKeys(expandHome(envFile)).has(apiKeyEnv) : false;
}

/** 整块写入 providers.<name>（新增或覆盖）。写坏了（loadEndpoints 校验不过）就回滚原文件。 */
export function writeProviderBlockForSync(name: string, block: Record<string, unknown>): void {
  if (!NAME_RE.test(name)) throw new Error(`非法 provider 名：${name}`);
  const p = configPath();
  const before = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  const doc = readDoc(p) ?? newDoc();
  doc.setIn(["providers", name], doc.createNode(block));
  if (!isRemote() && !doc.get("default")) {
    const models = Array.isArray(block.models) ? block.models : [];
    if (models.length) doc.set("default", modelName(models[0]));
  }
  try {
    writeConfig(p, doc);
  } catch (e) {
    if (before === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, before, "utf8");
    clearEndpointsCache();
    throw e;
  }
}
