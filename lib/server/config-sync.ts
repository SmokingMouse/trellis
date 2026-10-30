import "server-only";
import {
  CONFIG_KINDS,
  CONFIG_PACKAGE_FORMAT,
  CONFIG_PACKAGE_VERSION,
  decideAction,
  REDACTED,
  isConfigKind,
  itemId,
  type AgentPackItem,
  type ApprovalRulePackItem,
  type ConfigDiffItem,
  type ConfigKind,
  type ConfigPackage,
  type ImportResultItem,
  type ImportSelection,
  type ModelPackItem,
  type SettingPackItem,
  type SkillFile,
  type SkillPackItem,
} from "@/lib/config-sync";
import { approvalToolKey } from "@/lib/approval-rules";
import { createAgent, getAgentBySlug, isValidSlug, listAgents, updateAgent, type AgentRecord } from "./agents";
import { grantApprovalRule, listApprovalRules } from "./approval-rules";
import { applySkill, diffSkill, exportSkills, isSafeRelPath, isValidSkillName, userSkillsRoot } from "./config-sync-skills";
import { applyModel, exportModels, planModel } from "./config-sync-models";
import { exportRoles, planRoles, validateRole } from "./config-sync-roles";
import { API_KEY_ENV_RE, PROVIDER_NAME_RE, readRawEndpointsForSync } from "./model-config";
import { getAppSetting, setAppSetting } from "./repo";
import { listSkills } from "./skills";

// 配置同步（P4）的核心：导出可移植包、预览差异（dry-run）、按用户选择应用。
// 路由 app/api/export/config 与 app/api/import/config 只是薄壳。
//
// 每类的可移植单元 / 对齐键 / 冲突规则：
//   skills          目录名         同名内容不同 = 冲突；目标是软链 = 不可同步
//   agents          slug           只导自定义（builtin=0）；目标同 slug 是内置 / 是角色 = 不可同步
//   roles           slug           只导自定义角色 + USER.md + memories/（config-sync-roles.ts）
//   approval-rules  toolKey        只导「所有会话」规则；同键已有 = 相同（规则只有一个键，无冲突）
//   models          provider 名 / default   provider 整块比较（密钥按位置还原后再比）
//   settings        key            白名单 SYNC_SETTING_KEYS
// 冲突默认跳过，用户在预览里逐项改成覆盖。密钥规则见 config-sync-models.ts / -skills.ts。

/** 导入请求体上限。技能带内容时最大，单技能上限 8MB，一次同步几十个也够。 */
export const MAX_IMPORT_BYTES = 48 * 1024 * 1024;
const MAX_ITEMS_PER_KIND = 500;

/** 跟机器走、没有可移植意义的偏好不进来：push_* 依赖本机的推送订阅。 */
export const SYNC_SETTING_KEYS = ["label_model_claude", "label_model_codex"] as const;

export type SyncEnv = {
  /** 技能根，测试注入；默认 ~/.claude/skills */
  skillsRoot?: string;
};

export class ConfigSyncInputError extends Error {}

// ── 导出 ────────────────────────────────────────────────────────────────────

function agentToPack(a: AgentRecord): AgentPackItem {
  return {
    slug: a.slug,
    name: a.name,
    description: a.description,
    systemPrompt: a.systemPrompt,
    model: a.model,
    tools: a.tools,
    disallowedTools: a.disallowedTools,
    skills: a.skills,
    inheritEnv: a.inheritEnv,
    permission: a.permission,
    requireApproval: a.requireApproval,
    enabled: a.enabled,
    sortOrder: a.sortOrder,
  };
}

export function exportConfig(
  opts: { kinds: ConfigKind[]; skillNames?: string[] | null; skillContent: boolean },
  env: SyncEnv = {},
): ConfigPackage {
  const pkg: ConfigPackage = {
    format: CONFIG_PACKAGE_FORMAT,
    version: CONFIG_PACKAGE_VERSION,
    exportedAt: Date.now(),
    kinds: opts.kinds,
  };
  for (const kind of opts.kinds) {
    if (kind === "skills") {
      pkg.skills = exportSkills(env.skillsRoot ?? userSkillsRoot(), {
        names: opts.skillNames,
        withContent: opts.skillContent,
      });
    } else if (kind === "agents") {
      pkg.agents = listAgents()
        .filter((a) => !a.builtin)
        .map(agentToPack);
    } else if (kind === "roles") {
      pkg.roles = exportRoles();
    } else if (kind === "approval-rules") {
      pkg.approvalRules = listApprovalRules()
        .filter((r) => r.scope === "global")
        .map((r) => ({ toolKey: r.toolKey }));
    } else if (kind === "models") {
      pkg.models = exportModels();
    } else if (kind === "settings") {
      pkg.settings = SYNC_SETTING_KEYS.map((key) => ({ key, value: getAppSetting(key) })).filter(
        (s) => s.value !== null,
      );
    }
  }
  return pkg;
}

// ── 输入校验 ────────────────────────────────────────────────────────────────
// 包来自另一台机器（经浏览器转手），一律当不可信输入：结构、长度、枚举逐项校验，
// 不认识的字段丢掉。任何一项不合格整个请求 400，不做「能导多少导多少」。

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function fail(msg: string): never {
  throw new ConfigSyncInputError(msg);
}

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") fail(`${field} 必须是字符串`);
  if (v.length > max) fail(`${field} 过长`);
  return v;
}

function strOrNull(v: unknown, field: string, max: number): string | null {
  return v === null || v === undefined ? null : str(v, field, max);
}

function strList(v: unknown, field: string): string[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.length > 200) fail(`${field} 必须是 ≤200 项的数组`);
  return v.map((x, i) => str(x, `${field}[${i}]`, 200));
}

function list(v: unknown, field: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${field} 必须是数组`);
  if (v.length > MAX_ITEMS_PER_KIND) fail(`${field} 超过 ${MAX_ITEMS_PER_KIND} 项`);
  return v;
}

const PERMISSIONS = new Set(["full", "default", "readonly", "auto-edit"]);
const HOST_SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function validateAgent(v: unknown, i: number): AgentPackItem {
  const f = `agents[${i}]`;
  if (!isObj(v)) fail(`${f} 格式错误`);
  const slug = str(v.slug, `${f}.slug`, 32);
  if (!isValidSlug(slug)) fail(`${f}.slug 非法：${slug}`);
  const permission = v.permission ?? null;
  if (permission !== null && !PERMISSIONS.has(permission as string)) fail(`${f}.permission 非法`);
  const skillsRaw = v.skills ?? [];
  if (!Array.isArray(skillsRaw) || skillsRaw.length > 100) fail(`${f}.skills 格式错误`);
  const skills = skillsRaw.map((s, j): AgentPackItem["skills"][number] => {
    if (!isObj(s)) fail(`${f}.skills[${j}] 格式错误`);
    const name = str(s.name, `${f}.skills[${j}].name`, 100);
    if (!HOST_SKILL_RE.test(name)) fail(`${f}.skills[${j}].name 非法`);
    if (s.kind === "host") return { kind: "host", name };
    if (s.kind === "inline") return { kind: "inline", name, body: str(s.body, `${f}.skills[${j}].body`, 200_000) };
    fail(`${f}.skills[${j}].kind 非法`);
  });
  const requireApproval = v.requireApproval ?? null;
  if (requireApproval !== null && typeof requireApproval !== "boolean") fail(`${f}.requireApproval 非法`);
  const sortOrder = v.sortOrder ?? 100;
  if (typeof sortOrder !== "number" || !Number.isFinite(sortOrder)) fail(`${f}.sortOrder 非法`);
  return {
    slug,
    name: str(v.name, `${f}.name`, 200),
    description: str(v.description ?? "", `${f}.description`, 2000),
    systemPrompt: str(v.systemPrompt ?? "", `${f}.systemPrompt`, 200_000),
    model: strOrNull(v.model, `${f}.model`, 200),
    tools: strList(v.tools, `${f}.tools`),
    disallowedTools: strList(v.disallowedTools, `${f}.disallowedTools`),
    skills,
    inheritEnv: v.inheritEnv === true,
    permission: permission as AgentPackItem["permission"],
    requireApproval: requireApproval as boolean | null,
    enabled: v.enabled !== false,
    sortOrder: Math.trunc(sortOrder),
  };
}

const SHA_RE = /^[0-9a-f]{64}$/;

function validateSkill(v: unknown, i: number): SkillPackItem {
  const f = `skills[${i}]`;
  if (!isObj(v)) fail(`${f} 格式错误`);
  const name = str(v.name, `${f}.name`, 100);
  if (!isValidSkillName(name)) fail(`${f}.name 非法：${name}`);
  const filesRaw = v.files ?? [];
  if (!Array.isArray(filesRaw) || filesRaw.length > 1000) fail(`${f}.files 格式错误或超过 1000 个`);
  const files = filesRaw.map((x, j): SkillFile => {
    const ff = `${f}.files[${j}]`;
    if (!isObj(x)) fail(`${ff} 格式错误`);
    const p = str(x.path, `${ff}.path`, 1024);
    // 路径穿越在这里先拒一次（整包 400），applySkill 落盘前还会再断言一次。
    if (!isSafeRelPath(p)) fail(`${ff}.path 非法：${p}`);
    const sha = str(x.sha256, `${ff}.sha256`, 64);
    if (!SHA_RE.test(sha)) fail(`${ff}.sha256 非法`);
    if (typeof x.size !== "number" || x.size < 0) fail(`${ff}.size 非法`);
    const data = x.data === undefined ? undefined : str(x.data, `${ff}.data`, 3 * 1024 * 1024);
    return { path: p, mode: x.mode === 0o755 ? 0o755 : 0o644, size: x.size, sha256: sha, ...(data !== undefined ? { data } : {}) };
  });
  const excluded = (strList(v.excluded, `${f}.excluded`) ?? []).slice(0, 200);
  return {
    name,
    description: str(v.description ?? "", `${f}.description`, 2000),
    hash: str(v.hash ?? "", `${f}.hash`, 64),
    size: typeof v.size === "number" ? v.size : 0,
    files,
    excluded,
    ...(v.tooLarge === true ? { tooLarge: true } : {}),
  };
}

function validateRule(v: unknown, i: number): ApprovalRulePackItem {
  if (!isObj(v)) fail(`approvalRules[${i}] 格式错误`);
  return { toolKey: str(v.toolKey, `approvalRules[${i}].toolKey`, 200) };
}

function validateModel(v: unknown, i: number): ModelPackItem {
  const f = `models[${i}]`;
  if (!isObj(v)) fail(`${f} 格式错误`);
  if (v.type === "default") return { type: "default", model: str(v.model, `${f}.model`, 200) };
  if (v.type !== "provider") fail(`${f}.type 非法`);
  const name = str(v.name, `${f}.name`, 64);
  if (!PROVIDER_NAME_RE.test(name)) fail(`${f}.name 非法：${name}`);
  if (!isObj(v.block)) fail(`${f}.block 格式错误`);
  if (JSON.stringify(v.block).length > 64 * 1024) fail(`${f}.block 过大`);
  const block = v.block;
  const keyEnv = block.api_key_env;
  if (keyEnv !== undefined && (typeof keyEnv !== "string" || !API_KEY_ENV_RE.test(keyEnv))) {
    fail(`${f}.block.api_key_env 非法`);
  }
  for (const k of ["anthropic_url", "openai_url"]) {
    const u = block[k];
    if (u === undefined || u === REDACTED) continue;
    if (typeof u !== "string" || !/^https?:\/\//.test(u)) fail(`${f}.block.${k} 需以 http(s):// 开头`);
  }
  if (!Array.isArray(block.models) || block.models.length === 0) fail(`${f}.block.models 至少一项`);
  for (const m of block.models) {
    const ok = typeof m === "string" || (isObj(m) && typeof m.name === "string");
    if (!ok) fail(`${f}.block.models 项格式错误`);
  }
  return { type: "provider", name, block, redacted: (strList(v.redacted, `${f}.redacted`) ?? []).slice(0, 200) };
}

function validateSetting(v: unknown, i: number): SettingPackItem {
  if (!isObj(v)) fail(`settings[${i}] 格式错误`);
  return { key: str(v.key, `settings[${i}].key`, 100), value: strOrNull(v.value, `settings[${i}].value`, 1000) };
}

export function validatePackage(raw: unknown): ConfigPackage {
  if (!isObj(raw)) fail("package 必须是对象");
  if (raw.format !== CONFIG_PACKAGE_FORMAT) fail("不是 trellis 配置包（format 不符）");
  if (typeof raw.version !== "number") fail("缺 version");
  if (raw.version > CONFIG_PACKAGE_VERSION) {
    fail(`配置包版本 ${raw.version} 比目标机器支持的 ${CONFIG_PACKAGE_VERSION} 新，请先更新目标机器`);
  }
  if (raw.version < 1) fail(`不支持的配置包版本 ${raw.version}`);
  const kinds = Array.isArray(raw.kinds) ? raw.kinds.filter(isConfigKind) : [...CONFIG_KINDS];
  return {
    format: CONFIG_PACKAGE_FORMAT,
    version: CONFIG_PACKAGE_VERSION,
    exportedAt: typeof raw.exportedAt === "number" ? raw.exportedAt : 0,
    kinds,
    skills: list(raw.skills, "skills").map(validateSkill),
    agents: list(raw.agents, "agents").map(validateAgent),
    roles: list(raw.roles, "roles").map((v, i) => validateRole(v, i, fail)),
    approvalRules: list(raw.approvalRules, "approvalRules").map(validateRule),
    models: list(raw.models, "models").map(validateModel),
    settings: list(raw.settings, "settings").map(validateSetting),
  };
}

export function validateSelections(raw: unknown): ImportSelection[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > CONFIG_KINDS.length * MAX_ITEMS_PER_KIND) fail("items 格式错误");
  return raw.map((s, i) => {
    if (!isObj(s) || !isConfigKind(s.kind)) fail(`items[${i}].kind 非法`);
    return { kind: s.kind, key: str(s.key, `items[${i}].key`, 200), overwrite: s.overwrite === true };
  });
}

// ── 预览 ────────────────────────────────────────────────────────────────────

const AGENT_FIELDS: { key: keyof AgentPackItem; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "description", label: "描述" },
  { key: "systemPrompt", label: "系统提示词" },
  { key: "model", label: "模型" },
  { key: "tools", label: "工具白名单" },
  { key: "disallowedTools", label: "工具黑名单" },
  { key: "skills", label: "技能" },
  { key: "inheritEnv", label: "继承本机环境" },
  { key: "permission", label: "权限" },
  { key: "requireApproval", label: "需审批" },
  { key: "enabled", label: "启用" },
  { key: "sortOrder", label: "排序" },
];

type Plan = {
  diff: ConfigDiffItem;
  apply?: (action: "create" | "overwrite") => Pick<ImportResultItem, "outcome" | "message" | "warnings">;
};

function planAll(pkg: ConfigPackage, env: SyncEnv): Plan[] {
  const plans: Plan[] = [];
  const skillsRoot = env.skillsRoot ?? userSkillsRoot();

  for (const item of pkg.skills ?? []) {
    plans.push({
      diff: diffSkill(skillsRoot, item),
      apply: (action) => applySkill(skillsRoot, item, action),
    });
  }

  if (pkg.agents?.length) {
    // agent 引用的技能是「本机 ~/.claude/skills/<dir>」；目标没有就提示（不阻止：可能一起同步）。
    const syncingSkills = new Set((pkg.skills ?? []).map((s) => s.name));
    const targetSkills = new Set(listSkills("claude").flatMap((s) => [s.name, s.dir]));
    for (const item of pkg.agents) {
      const existing = getAgentBySlug(item.slug);
      const warnings = item.skills
        .filter((s) => s.kind === "host" && !targetSkills.has(s.name) && !syncingSkills.has(s.name))
        .map((s) => `引用的技能 ${s.name} 目标机器没有`);
      const base = { kind: "agents" as const, key: item.slug, label: item.name, summary: item.description || item.slug, warnings };
      let diff: ConfigDiffItem;
      if (!existing) diff = { ...base, status: "new" };
      // 角色也是 agents 表里的一行（kind='role'）：撞上它绝不能当成同名 Agent 去覆盖（P1 遗留）。
      else if (existing.kind === "role") diff = { ...base, status: "blocked", reason: "目标机器上同 slug 的是角色，不覆盖" };
      else if (existing.builtin) diff = { ...base, status: "blocked", reason: "目标机器上同 slug 的是内置 Agent，不覆盖" };
      else {
        const ours = agentToPack(existing);
        const changes = AGENT_FIELDS.filter((f) => JSON.stringify(ours[f.key]) !== JSON.stringify(item[f.key])).map(
          (f) => f.label,
        );
        diff = changes.length ? { ...base, status: "conflict", changes } : { ...base, status: "same", warnings: [] };
      }
      const { slug, ...rest } = item;
      plans.push({
        diff,
        apply: (action) => {
          if (action === "create") createAgent({ slug, ...rest });
          else updateAgent(getAgentBySlug(slug)!.id, rest);
          return { outcome: action === "create" ? "created" : "overwritten", warnings };
        },
      });
    }
  }

  plans.push(...planRoles(pkg.roles ?? []));

  if (pkg.approvalRules?.length) {
    const have = new Set(
      listApprovalRules()
        .filter((r) => r.scope === "global")
        .map((r) => r.toolKey),
    );
    for (const item of pkg.approvalRules) {
      const base = { kind: "approval-rules" as const, key: item.toolKey, label: item.toolKey, warnings: [] };
      // 同一套键规则（approvalToolKey）过一遍：问答 / 计划审批这类不允许建规则的键直接拒。
      const valid = approvalToolKey({ toolName: item.toolKey }) === item.toolKey;
      const diff: ConfigDiffItem = !valid
        ? { ...base, status: "blocked", reason: "不是可放行的规则键" }
        : have.has(item.toolKey)
          ? { ...base, status: "same" }
          : { ...base, status: "new", summary: "所有会话始终允许" };
      plans.push({
        diff,
        apply: () => {
          grantApprovalRule({ scope: "global", sessionId: "", interaction: { toolName: item.toolKey } });
          return { outcome: "created", warnings: [] };
        },
      });
    }
  }

  if (pkg.models?.length) {
    const raw = readRawEndpointsForSync();
    for (const item of pkg.models) {
      const planned = planModel(item, raw, pkg.models);
      plans.push({ diff: planned.diff, apply: () => applyModel(item, planned) });
    }
  }

  const allowed = new Set<string>(SYNC_SETTING_KEYS);
  for (const item of pkg.settings ?? []) {
    const base = { kind: "settings" as const, key: item.key, label: item.key, summary: item.value ?? "（默认）", warnings: [] };
    if (!allowed.has(item.key)) {
      plans.push({ diff: { ...base, status: "blocked", reason: "这个偏好跟机器走，不同步" } });
      continue;
    }
    const cur = getAppSetting(item.key);
    const diff: ConfigDiffItem =
      cur === item.value
        ? { ...base, status: "same" }
        : cur === null
          ? { ...base, status: "new" }
          : { ...base, status: "conflict", changes: [`${cur} → ${item.value ?? "（默认）"}`] };
    plans.push({
      diff,
      apply: (action) => {
        setAppSetting(item.key, item.value);
        return { outcome: action === "create" ? "created" : "overwritten", warnings: [] };
      },
    });
  }

  // 同一类里重复的键（手工拼的包）只认第一条，后面的标不可同步，免得同一项被应用两次。
  const seen = new Set<string>();
  for (const p of plans) {
    const id = itemId(p.diff.kind, p.diff.key);
    if (seen.has(id)) {
      p.diff = { ...p.diff, status: "blocked", reason: "包里重复出现", warnings: [] };
      p.apply = undefined;
    }
    seen.add(id);
  }
  return plans;
}

export function previewImport(pkg: ConfigPackage, env: SyncEnv = {}): ConfigDiffItem[] {
  return planAll(pkg, env).map((p) => p.diff);
}

/**
 * 应用。selections 为 null = 「全部新增项、冲突全跳过」（默认跳过）；否则只动选中的项，
 * 冲突项要 overwrite:true 才覆盖。应用前现算一遍差异（预览之后目标可能变了）。
 * 单项失败不影响其它项，结果逐项汇报。
 */
export function applyImport(
  pkg: ConfigPackage,
  selections: ImportSelection[] | null,
  env: SyncEnv = {},
): ImportResultItem[] {
  const plans = planAll(pkg, env);
  const byId = new Map<string, ImportSelection>();
  if (selections) for (const s of selections) byId.set(itemId(s.kind, s.key), s);
  const results: ImportResultItem[] = [];
  for (const p of plans) {
    const { kind, key, label, status } = p.diff;
    const sel = selections
      ? byId.get(itemId(kind, key))
      : status === "new" || status === "same"
        ? { kind, key }
        : undefined;
    const action = decideAction(status, sel);
    const base = { kind, key, label };
    if (action === "unchanged") {
      results.push({ ...base, outcome: "unchanged", warnings: [] });
      continue;
    }
    if (action === "skip" || !p.apply) {
      const message =
        status === "blocked" ? p.diff.reason : status === "conflict" && sel ? "冲突，按选择跳过" : undefined;
      results.push({ ...base, outcome: "skipped", message, warnings: [] });
      continue;
    }
    try {
      results.push({ ...base, ...p.apply(action) });
    } catch (e) {
      results.push({ ...base, outcome: "failed", message: e instanceof Error ? e.message : String(e), warnings: [] });
    }
  }
  return results;
}

