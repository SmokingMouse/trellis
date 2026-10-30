// 会话接力的可移植格式（客户端 / 服务端共用，纯函数无 IO）。
//
// 一份 RelayFile = 源机器上某个会话「根 → 选中叶节点」的那一条消息链，外加会话设置里
// 能跨机器生效的部分。刻意不带的：附件 blob（只带文件名清单）、工作区文件 / 路径、
// 任何 CLI resume id（claude/codex session 只活在源机器的磁盘上）、树上的其他分支。
//
// 导出：GET /api/export/session/<id>[?nodeId=]（挂 /api/export/ 下，受网关 shareOut 闸）
// 导入：POST /api/import/session（lib/server/session-relay.ts:importRelaySession）
//
// version 只在破坏性变更时加一；导入端遇到不认识的 version 直接拒，不猜。

export const RELAY_FORMAT = "trellis-session-relay" as const;
export const RELAY_VERSION = 1 as const;

/** 导入端的硬上限（导出端同一套，超了直接 413 而不是截断——截断的历史比没有更误导）。 */
export const RELAY_LIMITS = {
  /** 请求体 / 导出 JSON 的 UTF-8 字节上限。 */
  maxBytes: 8 * 1024 * 1024,
  maxMessages: 1000,
  /** 单条 question / response 的字符上限。 */
  maxText: 1024 * 1024,
  maxRefContent: 1024 * 1024,
  maxTitle: 200,
  maxSystemPrompt: 64 * 1024,
  maxToolCalls: 200,
  maxToolSummary: 300,
  maxAttachments: 50,
  maxShort: 512,
} as const;

export type RelayToolSummary = {
  name: string;
  status: "done" | "error";
  /** 人话摘要（命令 / 文件路径 / URL 等），≤ maxToolSummary 字符；不含工具输出。 */
  summary: string;
};

/** 原附件只带元信息——blob 本身留在源机器。 */
export type RelayAttachmentInfo = {
  filename: string | null;
  mime: string;
  size: number;
};

export type RelayReference = {
  sourceType: "url" | "paste";
  sourceUri: string | null;
  contentMd: string;
  title: string | null;
};

export type RelayMessage = {
  kind: "qa" | "reference";
  /** 用户这一轮的提问（reference 节点为空串）。 */
  question: string;
  /** 助手回答全文（error 节点可能是半截）。 */
  response: string;
  status: "done" | "error";
  errorMessage: string | null;
  createdAt: number;
  /** 从父回答里选中文字分叉时的那段原文。 */
  parentAnchor: string | null;
  topicLabel: string | null;
  toolCalls: RelayToolSummary[];
  attachments: RelayAttachmentInfo[];
  reference: RelayReference | null;
};

export type RelayFile = {
  format: typeof RELAY_FORMAT;
  version: typeof RELAY_VERSION;
  exportedAt: number;
  source: {
    sessionId: string;
    leafNodeId: string;
    /** 源会话的工作区目录名（只给名字不给路径，方便在目标机器上找对应仓库）。 */
    workspaceName: string | null;
    /** 源会话总节点数——messages 只是其中一条链，UI 可提示「其余 N 个分支没带」。 */
    totalNodes: number;
  };
  session: {
    title: string;
    mode: "chat" | "project";
    /** ProviderId；目标机器不认识就退回默认模型。 */
    model: string | null;
    /** 仅 chat 会话的自定义 system prompt。 */
    systemPrompt: string | null;
    /** Agent 按 slug 跨机对应（id 是机器本地的）。 */
    agentSlug: string | null;
    requireApproval: boolean;
  };
  messages: RelayMessage[];
};

export type RelayParseResult = { ok: true; file: RelayFile } | { ok: false; error: string };

type Obj = Record<string, unknown>;

class RelayInvalid extends Error {}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Obj, key: string, max: number, path: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new RelayInvalid(`${path}.${key} 必须是字符串`);
  if (v.length > max) throw new RelayInvalid(`${path}.${key} 超过 ${max} 字符上限`);
  return v;
}

function optStr(o: Obj, key: string, max: number, path: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  return str(o, key, max, path);
}

function num(o: Obj, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new RelayInvalid(`${path}.${key} 必须是非负数字`);
  }
  return v;
}

function bool(o: Obj, key: string): boolean {
  return o[key] === true;
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[], path: string): T {
  const v = o[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new RelayInvalid(`${path}.${key} 必须是 ${allowed.join(" / ")} 之一`);
  }
  return v as T;
}

function arr(o: Obj, key: string, max: number, path: string): unknown[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new RelayInvalid(`${path}.${key} 必须是数组`);
  if (v.length > max) throw new RelayInvalid(`${path}.${key} 超过 ${max} 项上限`);
  return v;
}

function parseMessage(raw: unknown, i: number): RelayMessage {
  const p = `messages[${i}]`;
  if (!isObj(raw)) throw new RelayInvalid(`${p} 必须是对象`);
  const L = RELAY_LIMITS;
  const kind = oneOf(raw, "kind", ["qa", "reference"] as const, p);
  const toolCalls = arr(raw, "toolCalls", L.maxToolCalls, p).map((t, j) => {
    const tp = `${p}.toolCalls[${j}]`;
    if (!isObj(t)) throw new RelayInvalid(`${tp} 必须是对象`);
    return {
      name: str(t, "name", L.maxShort, tp),
      status: oneOf(t, "status", ["done", "error"] as const, tp),
      summary: str(t, "summary", L.maxToolSummary, tp),
    };
  });
  const attachments = arr(raw, "attachments", L.maxAttachments, p).map((a, j) => {
    const ap = `${p}.attachments[${j}]`;
    if (!isObj(a)) throw new RelayInvalid(`${ap} 必须是对象`);
    return {
      filename: optStr(a, "filename", L.maxShort, ap),
      mime: str(a, "mime", L.maxShort, ap),
      size: num(a, "size", ap),
    };
  });
  let reference: RelayReference | null = null;
  if (kind === "reference") {
    const r = raw.reference;
    if (!isObj(r)) throw new RelayInvalid(`${p}.reference 必须是对象（kind=reference）`);
    reference = {
      sourceType: oneOf(r, "sourceType", ["url", "paste"] as const, `${p}.reference`),
      sourceUri: optStr(r, "sourceUri", 4096, `${p}.reference`),
      contentMd: str(r, "contentMd", L.maxRefContent, `${p}.reference`),
      title: optStr(r, "title", L.maxShort, `${p}.reference`),
    };
  }
  return {
    kind,
    question: str(raw, "question", L.maxText, p),
    response: str(raw, "response", L.maxText, p),
    status: oneOf(raw, "status", ["done", "error"] as const, p),
    errorMessage: optStr(raw, "errorMessage", 4096, p),
    createdAt: num(raw, "createdAt", p),
    parentAnchor: optStr(raw, "parentAnchor", L.maxText, p),
    topicLabel: optStr(raw, "topicLabel", L.maxShort, p),
    toolCalls,
    attachments,
    reference,
  };
}

/** 严格校验一份外来的 RelayFile。只认白名单字段，多余字段丢弃；任何类型 / 长度不符直接拒。 */
export function parseRelayFile(raw: unknown): RelayParseResult {
  try {
    if (!isObj(raw)) throw new RelayInvalid("接力数据必须是 JSON 对象");
    if (raw.format !== RELAY_FORMAT) throw new RelayInvalid(`format 必须是 ${RELAY_FORMAT}`);
    if (raw.version !== RELAY_VERSION) {
      throw new RelayInvalid(`不支持的接力格式版本 ${String(raw.version)}（本机支持 ${RELAY_VERSION}）`);
    }
    const L = RELAY_LIMITS;
    const source = raw.source;
    if (!isObj(source)) throw new RelayInvalid("source 必须是对象");
    const session = raw.session;
    if (!isObj(session)) throw new RelayInvalid("session 必须是对象");
    const rawMessages = arr(raw, "messages", L.maxMessages, "file");
    if (rawMessages.length === 0) throw new RelayInvalid("messages 不能为空");
    const messages = rawMessages.map(parseMessage);
    // 链的形状约束：reference 只能当根（它在源树里本来就是浮动根），其余全是 qa。
    messages.forEach((m, i) => {
      if (m.kind === "reference" && i !== 0) throw new RelayInvalid(`messages[${i}] reference 只能出现在链首`);
    });
    const title = str(session, "title", L.maxTitle, "session").trim();
    const file: RelayFile = {
      format: RELAY_FORMAT,
      version: RELAY_VERSION,
      exportedAt: num(raw, "exportedAt", "file"),
      source: {
        sessionId: str(source, "sessionId", L.maxShort, "source"),
        leafNodeId: str(source, "leafNodeId", L.maxShort, "source"),
        workspaceName: optStr(source, "workspaceName", L.maxShort, "source"),
        totalNodes: num(source, "totalNodes", "source"),
      },
      session: {
        title: title || "接力会话",
        mode: oneOf(session, "mode", ["chat", "project"] as const, "session"),
        model: optStr(session, "model", L.maxShort, "session"),
        systemPrompt: optStr(session, "systemPrompt", L.maxSystemPrompt, "session"),
        agentSlug: optStr(session, "agentSlug", 64, "session"),
        requireApproval: bool(session, "requireApproval"),
      },
      messages,
    };
    return { ok: true, file };
  } catch (e) {
    if (e instanceof RelayInvalid) return { ok: false, error: e.message };
    throw e;
  }
}

/** 机器名的合法形状（与网关 VIA_RE 的 node 段一致）。 */
export const RELAY_MACHINE_RE = /^[a-z0-9-]{1,64}$/;

/** 导入会话的标题：原标题 + 来源后缀，总长不超过 maxTitle。 */
export function relayTitle(title: string, from: string | null): string {
  const suffix = from ? `（接力自 ${from}）` : "（接力）";
  const room = Math.max(1, RELAY_LIMITS.maxTitle - suffix.length);
  return `${title.slice(0, room)}${suffix}`;
}
