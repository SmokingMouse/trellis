import { isMap, parseDocument } from "yaml";

export type EndpointPayload = {
  name: string;
  anthropic_url?: string;
  openai_url?: string;
  api_key_env: string;
  apiKey?: string;
  models: string[];
};

const DEFAULT_ENV_FILE = "~/.config/sm/.env";
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

function marker(id: string, edge: "begin" | "end"): string {
  return `# fj-share:${id}:${edge}`;
}

function stripMarkedBlock(contents: string, id: string): string {
  const begin = marker(id, "begin");
  const end = marker(id, "end");
  const output: string[] = [];
  let skipping = false;
  let foundBegin = false;
  for (const line of contents.split("\n")) {
    if (line.trim() === begin) {
      if (skipping) throw new Error(`nested share marker: ${id}`);
      skipping = true;
      foundBegin = true;
      continue;
    }
    if (line.trim() === end) {
      if (!skipping) throw new Error(`orphan share marker end: ${id}`);
      skipping = false;
      continue;
    }
    if (!skipping) output.push(line);
  }
  if (skipping) throw new Error(`unterminated share marker: ${id}`);
  if (!foundBegin) return contents;
  return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function defaultKeyEnv(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

export function validateEndpointPayload(value: unknown): EndpointPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("endpoint payload must be an object");
  }
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!NAME_RE.test(name)) throw new Error("invalid endpoint provider name");
  const anthropicUrl = typeof raw.anthropic_url === "string" && raw.anthropic_url.trim()
    ? raw.anthropic_url.trim()
    : undefined;
  const openaiUrl = typeof raw.openai_url === "string" && raw.openai_url.trim()
    ? raw.openai_url.trim()
    : undefined;
  for (const url of [anthropicUrl, openaiUrl]) {
    if (url && !/^https?:\/\//.test(url)) throw new Error("endpoint URL must use http(s)");
  }
  if (!Array.isArray(raw.models)) throw new Error("endpoint models must be an array");
  const models = raw.models.map((model) => typeof model === "string" ? model.trim() : "").filter(Boolean);
  if (models.length === 0 || models.length !== raw.models.length) {
    throw new Error("endpoint models must contain non-empty strings");
  }
  const apiKeyEnv = typeof raw.api_key_env === "string" && raw.api_key_env.trim()
    ? raw.api_key_env.trim()
    : defaultKeyEnv(name);
  if (!ENV_RE.test(apiKeyEnv)) throw new Error("invalid endpoint api_key_env");
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : undefined;
  if (apiKey !== undefined && (!apiKey || /[\r\n]/.test(apiKey))) {
    throw new Error("invalid endpoint apiKey");
  }
  return {
    name,
    ...(anthropicUrl ? { anthropic_url: anthropicUrl } : {}),
    ...(openaiUrl ? { openai_url: openaiUrl } : {}),
    api_key_env: apiKeyEnv,
    ...(apiKey ? { apiKey } : {}),
    models,
  };
}

function parse(contents: string) {
  // 空内容给空文档而非 "{}"：flow map 根会让 doc.set 塞裸 JS 对象(非 YAMLMap)，
  // 且新文件应输出块风格。
  const doc = parseDocument(contents);
  if (doc.errors.length > 0) throw new Error(`invalid endpoints.yaml: ${doc.errors[0].message}`);
  return doc;
}

function envFileFrom(contents: string): string | null {
  if (!contents.trim()) return null;
  const value = parse(contents).get("env_file");
  return typeof value === "string" && value ? value : null;
}

export function injectEndpointConfig(
  contents: string,
  id: string,
  input: unknown,
): { contents: string; envFile: string | null; payload: EndpointPayload } {
  const payload = validateEndpointPayload(input);
  const clean = stripMarkedBlock(contents, id);
  const doc = parse(clean);
  let providers = doc.get("providers", true);
  if (providers === undefined) {
    doc.set("providers", doc.createNode({}));
    providers = doc.get("providers", true);
  }
  if (!isMap(providers)) throw new Error("endpoints.yaml providers must be a map");
  if (providers.has(payload.name)) {
    throw new Error(`endpoint provider already exists: ${payload.name}`);
  }
  const block: Record<string, unknown> = { api_key_env: payload.api_key_env };
  if (payload.anthropic_url) block.anthropic_url = payload.anthropic_url;
  if (payload.openai_url) block.openai_url = payload.openai_url;
  block.models = payload.models;
  const pair = doc.createPair(payload.name, block);
  if (typeof pair.key === "object" && pair.key) pair.key.commentBefore = ` fj-share:${id}:begin`;
  if (typeof pair.value === "object" && pair.value) pair.value.comment = ` fj-share:${id}:end`;
  providers.items.push(pair);
  if (!doc.get("default")) doc.set("default", payload.models[0]);
  let envFile = envFileFrom(clean);
  if (payload.apiKey && !envFile) {
    envFile = DEFAULT_ENV_FILE;
    doc.set("env_file", envFile);
  }
  return { contents: doc.toString(), envFile, payload };
}

export function removeEndpointConfig(
  contents: string,
  id: string,
): { contents: string; envFile: string | null } {
  return { contents: stripMarkedBlock(contents, id), envFile: envFileFrom(contents) };
}

export function injectEndpointEnv(contents: string, id: string, key: string, value: string): string {
  const clean = stripMarkedBlock(contents, id).replace(/\n+$/, "");
  const block = `${marker(id, "begin")}\n${key}=${value}\n${marker(id, "end")}\n`;
  return clean ? `${clean}\n${block}` : block;
}

export function removeEndpointEnv(contents: string, id: string): string {
  const clean = stripMarkedBlock(contents, id).replace(/\n+$/, "");
  return clean ? `${clean}\n` : "";
}
