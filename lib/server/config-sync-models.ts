import "server-only";
import { REDACTED, type ConfigDiffItem, type ImportResultItem, type ModelPackItem } from "@/lib/config-sync";
import {
  apiKeyPresent,
  readRawEndpointsForSync,
  setDefaultModel,
  writeProviderBlockForSync,
  type RawEndpoints,
} from "./model-config";

// 配置同步 · 模型与服务商（endpoints.yaml 的 providers.<name> 整块 + default）。
//
// API Key 本来就不在 yaml 里（住在 env_file，按 api_key_env 引用），所以 provider 块的
// 主体可以直接搬；要防的是块里「顺手写进去的」密钥：
//   - claude.env / models[].claude.env / model_settings.*.claude.env 里名字像密钥的变量
//     （*_KEY / *_TOKEN / *_SECRET / *_AUTH_* / PASSWORD / COOKIE …，按 _ 分段判，
//     MAX_THINKING_TOKENS 这种复数 TOKENS 不算）
//   - 任意层名字本身就是密钥的字段（api_key / token / secret / password …；api_key_env
//     只是变量名，不算）
//   - claude.args 里的 --xxx-key / --token 之类参数值
//   - 带 user:pass@ 的 URL
// 导出时这些值一律换成 REDACTED；导入时按位置从目标机器已有的同名 provider 里取回，
// 取不回的：env / 字段直接删掉并提示补，URL 取不回则整项不可同步（删了 URL 会把第三方
// 端点变成「原生 claude」，语义就错了）。

const SENSITIVE_SEGMENTS = new Set([
  "KEY",
  "APIKEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
  "AUTH",
  "PRIVATE",
]);

function segments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** 环境变量名 / 字段名像不像密钥。 */
export function isSensitiveName(name: string): boolean {
  if (/^api_key_env$/i.test(name)) return false;
  return segments(name).some((s) => SENSITIVE_SEGMENTS.has(s));
}

function urlHasCredentials(v: string): boolean {
  try {
    const u = new URL(v);
    return Boolean(u.username || u.password);
  } catch {
    return false;
  }
}

const SENSITIVE_FLAG_RE = /^--?[A-Za-z0-9_-]*(key|token|secret|password|passwd|auth)[A-Za-z0-9_-]*$/i;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 打码一个 provider 块：返回深拷贝 + 被打码的字段路径（人读格式，不含值）。 */
export function redactBlock(block: Record<string, unknown>): { block: Record<string, unknown>; redacted: string[] } {
  const redacted: string[] = [];
  const walk = (v: Json, at: string, key: string | null): Json => {
    if (Array.isArray(v)) {
      const out: Json[] = [];
      for (let i = 0; i < v.length; i++) {
        const el = v[i];
        const p = `${at}[${i}]`;
        if (key === "args" && typeof el === "string") {
          const eq = el.indexOf("=");
          const flag = eq > 0 ? el.slice(0, eq) : el;
          if (eq > 0 && SENSITIVE_FLAG_RE.test(flag)) {
            out.push(REDACTED);
            redacted.push(p);
            continue;
          }
          const prev = v[i - 1];
          if (typeof prev === "string" && !prev.includes("=") && SENSITIVE_FLAG_RE.test(prev) && !el.startsWith("-")) {
            out.push(REDACTED);
            redacted.push(p);
            continue;
          }
        }
        out.push(walk(el, p, null));
      }
      return out;
    }
    if (v && typeof v === "object") {
      const out: { [k: string]: Json } = {};
      for (const [k, child] of Object.entries(v)) {
        const p = at ? `${at}.${k}` : k;
        if (typeof child === "string" && (isSensitiveName(k) || urlHasCredentials(child))) {
          out[k] = REDACTED;
          redacted.push(p);
          continue;
        }
        out[k] = walk(child, p, k);
      }
      return out;
    }
    return v;
  };
  return { block: walk(block as Json, "", null) as Record<string, unknown>, redacted };
}

const DROP = Symbol("drop");

type RestoreReport = { missing: string[]; urlMissing: string[] };

/**
 * 把包里的 REDACTED 按位置换回目标机器已有的值。数组里带 name 的对象（models[]）按
 * name 对齐，其余按下标。取不回的删掉（args 里连同前面那个 flag 一起删）。
 */
export function restoreSecrets(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): { block: Record<string, unknown>; report: RestoreReport } {
  const report: RestoreReport = { missing: [], urlMissing: [] };
  const walk = (v: unknown, t: unknown, at: string, key: string | null): unknown => {
    if (v === REDACTED) {
      if (typeof t === "string" && t !== REDACTED) return t;
      if (key && /url$/i.test(key)) report.urlMissing.push(at);
      else report.missing.push(at);
      return DROP;
    }
    if (Array.isArray(v)) {
      const tArr = Array.isArray(t) ? t : [];
      const out: unknown[] = [];
      v.forEach((el, i) => {
        const named = el && typeof el === "object" && typeof (el as { name?: unknown }).name === "string";
        const tEl = named
          ? tArr.find((x) => x && typeof x === "object" && (x as { name?: unknown }).name === (el as { name: string }).name)
          : tArr[i];
        const r = walk(el, tEl, `${at}[${i}]`, null);
        if (r === DROP) {
          const prev = out[out.length - 1];
          if (key === "args" && typeof prev === "string" && !prev.includes("=") && SENSITIVE_FLAG_RE.test(prev)) out.pop();
          return;
        }
        out.push(r);
      });
      return out;
    }
    if (v && typeof v === "object") {
      const tObj = t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, unknown>) : {};
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        const r = walk(child, tObj[k], at ? `${at}.${k}` : k, k);
        if (r !== DROP) out[k] = r;
      }
      return out;
    }
    return v;
  };
  return { block: walk(incoming, existing, "", null) as Record<string, unknown>, report };
}

/** 键排序后的稳定序列化，判「完全相同」用。 */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function modelNames(block: Record<string, unknown>): string[] {
  const models = Array.isArray(block.models) ? block.models : [];
  return models.map((m) => (m && typeof m === "object" ? String((m as { name?: unknown }).name) : String(m)));
}

// ── 导出 ────────────────────────────────────────────────────────────────────

export function exportModels(raw: RawEndpoints = readRawEndpointsForSync()): ModelPackItem[] {
  const items: ModelPackItem[] = [];
  for (const [name, block] of Object.entries(raw.providers)) {
    if (!block || typeof block !== "object") continue;
    const r = redactBlock(block);
    items.push({ type: "provider", name, block: r.block, redacted: r.redacted });
  }
  if (raw.defaultModel) items.push({ type: "default", model: raw.defaultModel });
  return items;
}

export function modelItemKey(item: ModelPackItem): string {
  return item.type === "default" ? "default" : `provider:${item.name}`;
}

// ── 预览 / 应用 ─────────────────────────────────────────────────────────────

type Planned = {
  diff: ConfigDiffItem;
  /** provider：还原密钥后要写入的块 */
  block?: Record<string, unknown>;
};

function isNative(block: Record<string, unknown>): boolean {
  return !block.anthropic_url && !block.openai_url;
}

export function planModel(item: ModelPackItem, raw: RawEndpoints): Planned {
  if (item.type === "default") {
    const base = { kind: "models" as const, key: "default", label: "默认模型", summary: item.model, warnings: [] as string[] };
    const known = Object.values(raw.providers).some((b) => b && modelNames(b).includes(item.model));
    if (!known) base.warnings.push(`目标机器的服务商里没有模型 ${item.model}（可一并同步对应的服务商）`);
    if (!raw.defaultModel) return { diff: { ...base, status: "new" } };
    if (raw.defaultModel === item.model) return { diff: { ...base, status: "same", warnings: [] } };
    return { diff: { ...base, status: "conflict", changes: [`${raw.defaultModel} → ${item.model}`] } };
  }

  const existing = raw.providers[item.name];
  const { block, report } = restoreSecrets(item.block, existing);
  const base = {
    kind: "models" as const,
    key: modelItemKey(item),
    label: item.name,
    summary: modelNames(item.block).join("、") || "（无模型）",
    warnings: [] as string[],
  };
  if (report.urlMissing.length) {
    return {
      diff: {
        ...base,
        status: "blocked",
        reason: `端点 URL 内含凭证（${report.urlMissing.join("、")}），导出时已剔除，目标机器没有可沿用的值；请在目标机器手动添加`,
      },
    };
  }
  for (const p of report.missing) base.warnings.push(`${p} 是密钥，未同步；目标机器没有同名值，需要手动补`);
  const keyEnv = typeof block.api_key_env === "string" ? block.api_key_env : null;
  if (keyEnv && !isNative(block) && !apiKeyPresent(keyEnv, raw.envFile)) {
    base.warnings.push(`目标机器没有 ${keyEnv}，应用后到「模型与服务商」补 API Key`);
  }
  if (!existing) return { diff: { ...base, status: "new" }, block };
  if (stableJson(existing) === stableJson(block)) return { diff: { ...base, status: "same", warnings: [] }, block };
  const keys = new Set([...Object.keys(existing), ...Object.keys(block)]);
  const changes = [...keys].filter((k) => stableJson(existing[k]) !== stableJson(block[k]));
  return { diff: { ...base, status: "conflict", changes }, block };
}

export function applyModel(
  item: ModelPackItem,
  planned: Planned,
): Pick<ImportResultItem, "outcome" | "message" | "warnings"> {
  if (item.type === "default") {
    setDefaultModel(item.model);
  } else {
    writeProviderBlockForSync(item.name, planned.block!);
  }
  return {
    outcome: planned.diff.status === "new" ? "created" : "overwritten",
    warnings: planned.diff.warnings,
  };
}
