// 配置同步（P4）：客户端与服务端共用的类型、类别表与纯逻辑。
//
// 流程：浏览器经 hub 的 /__gw/via 从来源机器 GET /api/export/config 拿可移植包 →
// POST 到目标机器 /api/import/config（dryRun 预览差异 → 用户逐项勾选 → 实际应用）。
// 单向、手动、可预览；不做自动双向同步。
//
// 密钥一律不出机器：导出时剔除 / 打码，导入时目标保留自己已有的值，目标没有就留空并在
// 结果里提示需要补。存储与读写在 lib/server/config-sync*.ts。

export const CONFIG_PACKAGE_FORMAT = "trellis-config";
export const CONFIG_PACKAGE_VERSION = 1;

/** 打码占位：导出包里凡是密钥值都换成它，导入时按路径从目标已有配置里取回。 */
export const REDACTED = "__trellis_redacted__";

export const CONFIG_KINDS = ["skills", "agents", "approval-rules", "models", "settings"] as const;
export type ConfigKind = (typeof CONFIG_KINDS)[number];

export const CONFIG_KIND_META: Record<ConfigKind, { label: string; hint: string }> = {
  skills: { label: "技能", hint: "~/.claude/skills 下的技能目录（含脚本），敏感文件不同步" },
  agents: { label: "自定义 Agent", hint: "按 slug 对齐；内置 Agent 不同步" },
  "approval-rules": { label: "审批规则", hint: "只同步「所有会话」规则；会话规则绑定本机会话，不同步" },
  models: { label: "模型与服务商", hint: "endpoints.yaml 的服务商块与默认模型；API Key 不同步" },
  settings: { label: "服务端偏好", hint: "打标 / 起题模型等；推送开关是每台机器自己的，不同步" },
};

export function isConfigKind(v: unknown): v is ConfigKind {
  return typeof v === "string" && (CONFIG_KINDS as readonly string[]).includes(v);
}

/** `?kinds=a,b` → 合法类别（去重、保序）；空 / 全非法 = 全部。 */
export function parseKinds(raw: string | null | undefined): ConfigKind[] {
  const picked = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isConfigKind);
  const uniq = [...new Set(picked)];
  return uniq.length ? uniq : [...CONFIG_KINDS];
}

// ── 包结构 ──────────────────────────────────────────────────────────────────

export type SkillFile = {
  /** 相对技能目录的 posix 路径 */
  path: string;
  /** 0o755（可执行）或 0o644 */
  mode: number;
  size: number;
  sha256: string;
  /** base64 内容。清单模式（预览）不带；应用前按名单再取一次带内容的包 */
  data?: string;
};

export type SkillPackItem = {
  name: string;
  description: string;
  /** 文件清单 + 内容的 sha256，预览靠它判「相同」 */
  hash: string;
  size: number;
  /** 文件清单（总是带）；超限时为空 */
  files: SkillFile[];
  /** 按敏感文件 / 依赖目录规则没带出来的相对路径（只给名字，不给内容） */
  excluded: string[];
  /** 超过单技能上限：不可同步 */
  tooLarge?: boolean;
};

export type AgentPackItem = {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  tools: string[] | null;
  disallowedTools: string[] | null;
  skills: ({ kind: "host"; name: string } | { kind: "inline"; name: string; body: string })[];
  inheritEnv: boolean;
  permission: "full" | "default" | "readonly" | "auto-edit" | null;
  requireApproval: boolean | null;
  enabled: boolean;
  sortOrder: number;
};

export type ApprovalRulePackItem = { toolKey: string };

export type ModelPackItem =
  | {
      type: "provider";
      name: string;
      /** endpoints.yaml 里 providers.<name> 整块，密钥值已换成 REDACTED */
      block: Record<string, unknown>;
      /** 被打码 / 剔除的字段路径（给预览看，不含值） */
      redacted: string[];
    }
  | { type: "default"; model: string };

export type SettingPackItem = { key: string; value: string | null };

export type ConfigPackage = {
  format: typeof CONFIG_PACKAGE_FORMAT;
  version: typeof CONFIG_PACKAGE_VERSION;
  exportedAt: number;
  kinds: ConfigKind[];
  skills?: SkillPackItem[];
  agents?: AgentPackItem[];
  approvalRules?: ApprovalRulePackItem[];
  models?: ModelPackItem[];
  settings?: SettingPackItem[];
};

// ── 预览 / 应用 ────────────────────────────────────────────────────────────

/** new = 目标没有；conflict = 同名但内容不同；same = 完全一致；blocked = 不能同步（原因见 reason） */
export type DiffStatus = "new" | "conflict" | "same" | "blocked";

export type ConfigDiffItem = {
  kind: ConfigKind;
  key: string;
  label: string;
  status: DiffStatus;
  /** 一行说明（如技能的文件数 / 大小、模型列表） */
  summary?: string;
  /** conflict：哪些字段不同 */
  changes?: string[];
  /** blocked 的原因 */
  reason?: string;
  /** 应用后仍需用户处理的事（缺 Key、缺技能等） */
  warnings: string[];
};

export type ImportSelection = { kind: ConfigKind; key: string; overwrite?: boolean };

export type ImportOutcome = "created" | "overwritten" | "skipped" | "unchanged" | "failed";

export type ImportResultItem = {
  kind: ConfigKind;
  key: string;
  label: string;
  outcome: ImportOutcome;
  message?: string;
  warnings: string[];
};

export const OUTCOME_LABEL: Record<ImportOutcome, string> = {
  created: "已新增",
  overwritten: "已覆盖",
  skipped: "已跳过",
  unchanged: "无需变更",
  failed: "失败",
};

export const STATUS_LABEL: Record<DiffStatus, string> = {
  new: "新增",
  conflict: "冲突",
  same: "相同",
  blocked: "不可同步",
};

export function itemId(kind: ConfigKind, key: string): string {
  return `${kind}\u0000${key}`;
}

/**
 * 应用时某项该怎么处理（纯函数，服务端应用与客户端汇总共用）：
 * - 没选中 → skip
 * - new → create；same → unchanged；blocked → skip
 * - conflict → 勾了覆盖才 overwrite，否则 skip（默认跳过）
 */
export function decideAction(
  status: DiffStatus,
  selection: ImportSelection | undefined,
): "create" | "overwrite" | "skip" | "unchanged" {
  if (!selection) return "skip";
  if (status === "new") return "create";
  if (status === "same") return "unchanged";
  if (status === "conflict") return selection.overwrite ? "overwrite" : "skip";
  return "skip";
}
