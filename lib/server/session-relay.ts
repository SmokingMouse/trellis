import "server-only";
// 会话接力：A 机器上的一段对话搬到 B 机器上接着聊。
//
//   exportRelaySession  —— 读本机会话，产出可移植的 RelayFile（格式见 lib/session-relay.ts）
//   importRelaySession  —— 校验外来 RelayFile，在本机新建会话（路由 / 跨机派活都直接调它）
//   buildRelayHistory   —— chat 路由用：接力会话的某一轮「历史不在 CLI session 里」时，
//                          把根→父整条链折叠成 ChatMessage[]（导入的节点没有 resume id，
//                          默认的 depth=4 折叠窗口会把更早的接力历史丢掉）
//
// 不跟着走的：附件 blob（只带文件名，导入后在提问末尾注明）、工作区文件与路径、
// CLI resume id、树上的其他分支、笔记 / 书签 / 已读状态。
import path from "node:path";
import fs from "node:fs";
import type { ChatMessage } from "@/lib/llm";
import { isProviderId } from "@/lib/llm";
import type { ToolCall } from "@/lib/types";
import { readableNodeRefs } from "@/lib/node-refs";
import { toolSummary, toolTitle } from "@/lib/tool-registry";
import {
  RELAY_FORMAT,
  RELAY_LIMITS,
  RELAY_MACHINE_RE,
  RELAY_VERSION,
  parseRelayFile,
  relayTitle,
  type RelayFile,
  type RelayMessage,
  type RelayToolSummary,
} from "@/lib/session-relay";
import {
  createRelaySession,
  getNode,
  getNodeChain,
  getSession,
  getSessionNodes,
  getSessionRelayJson,
  latestNodeIdInSession,
  type ApiNode,
  type RelayNodeInsert,
} from "./repo";
import { getAgent, getAgentBySlug } from "./agents";

export class RelayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toolSummaries(calls: ToolCall[]): RelayToolSummary[] {
  // 只带主 agent 的调用（子 agent 内部步骤是噪音），且只带摘要不带输出——输出里
  // 常有文件全文 / 命令结果，既大又最可能是「不该流出」的内容。
  const out: RelayToolSummary[] = [];
  for (const c of calls) {
    if (c.parentToolUseId) continue;
    if (out.length >= RELAY_LIMITS.maxToolCalls) break;
    let summary = "";
    try {
      summary = toolSummary(c) ?? "";
    } catch {
      summary = "";
    }
    const title = (() => {
      try {
        return toolTitle(c);
      } catch {
        return c.name;
      }
    })();
    out.push({
      name: clip(c.name || "tool", RELAY_LIMITS.maxShort),
      status: c.status === "error" ? "error" : "done",
      summary: clip(summary && summary !== title ? `${title} · ${summary}` : title, RELAY_LIMITS.maxToolSummary),
    });
  }
  return out;
}

function nodeToMessage(n: ApiNode): RelayMessage {
  const isRef = n.kind === "reference" && n.reference !== null;
  const status: RelayMessage["status"] = n.status === "done" ? "done" : "error";
  return {
    kind: isRef ? "reference" : "qa",
    question: n.question,
    response: n.response,
    status,
    errorMessage:
      n.status === "streaming" ? "导出时这一轮还在生成，回答不完整" : n.status === "error" ? (n.errorMessage ?? "error") : null,
    createdAt: n.createdAt,
    parentAnchor: n.parentAnchor?.selectedText ?? null,
    topicLabel: n.topicLabel,
    toolCalls: toolSummaries(n.toolCalls),
    attachments: n.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size })),
    reference: isRef
      ? {
          sourceType: n.reference!.sourceType,
          sourceUri: n.reference!.sourceUri,
          contentMd: n.reference!.contentMd,
          title: n.reference!.meta.title ?? null,
        }
      : null,
  };
}

/** 导出本机会话 sessionId 的「根 → leafNodeId」链。leafNodeId 缺省 = 会话里最近的节点。 */
export function exportRelaySession(sessionId: string, leafNodeId?: string | null): RelayFile {
  const session = getSession(sessionId);
  if (!session) throw new RelayError(404, "会话不存在");
  const leafId = leafNodeId || latestNodeIdInSession(sessionId);
  if (!leafId) throw new RelayError(409, "会话里还没有消息");
  const leaf = getNode(leafId);
  if (!leaf || leaf.sessionId !== sessionId) throw new RelayError(404, "节点不在这个会话里");
  const chain = getNodeChain(leafId);
  // reference 只会是浮动根；链中间出现 reference（理论上不该有）就从它之后截起。
  let start = 0;
  chain.forEach((n, i) => {
    if (i > 0 && n.kind === "reference") start = i;
  });
  const messages = chain.slice(start).map(nodeToMessage);
  if (messages.length > RELAY_LIMITS.maxMessages) {
    throw new RelayError(413, `这条对话有 ${messages.length} 轮，超过接力上限 ${RELAY_LIMITS.maxMessages}`);
  }
  for (const m of messages) {
    if (m.question.length > RELAY_LIMITS.maxText || m.response.length > RELAY_LIMITS.maxText) {
      throw new RelayError(413, "有一轮对话超过单条长度上限，没法接力");
    }
    if (m.reference && m.reference.contentMd.length > RELAY_LIMITS.maxRefContent) {
      throw new RelayError(413, "参考材料超过长度上限，没法接力");
    }
  }
  const agent = session.agentId ? getAgent(session.agentId) : null;
  const mode = session.mode === "project" ? "project" : "chat";
  const file: RelayFile = {
    format: RELAY_FORMAT,
    version: RELAY_VERSION,
    exportedAt: Date.now(),
    source: {
      sessionId,
      leafNodeId: leafId,
      workspaceName: session.workspacePath ? path.basename(session.workspacePath) : null,
      totalNodes: getSessionNodes(sessionId).length,
    },
    session: {
      title: clip(session.title, RELAY_LIMITS.maxTitle),
      mode,
      model: session.model,
      systemPrompt: mode === "chat" ? session.systemPrompt : null,
      agentSlug: agent?.slug ?? null,
      requireApproval: session.requireApproval,
    },
    messages,
  };
  if (Buffer.byteLength(JSON.stringify(file), "utf8") > RELAY_LIMITS.maxBytes) {
    throw new RelayError(413, `这段对话超过接力大小上限 ${RELAY_LIMITS.maxBytes / 1024 / 1024} MB`);
  }
  return file;
}

export type RelayImportOptions = {
  /** 来源机器名（显示在标题后缀 / relay_json）；null = 不知道。 */
  from?: string | null;
  /** 目标机器上的工作区绝对路径；给了就以 project 模式导入，否则 chat。 */
  workspacePath?: string | null;
  now?: number;
};

export type RelayImportResult = {
  sessionId: string;
  leafNodeId: string;
  /** 本机可直接打开的页面路径（经 hub 时拼 goHref(<机器>, path)）。 */
  path: string;
  title: string;
  mode: "chat" | "project";
};

type RelayMeta = {
  version: 1;
  from: string | null;
  sourceSessionId: string;
  sourceLeafNodeId: string;
  exportedAt: number;
  importedAt: number;
  workspaceName: string | null;
  importedNodeIds: string[];
};

function attachmentNote(m: RelayMessage): string {
  if (m.attachments.length === 0) return "";
  const names = m.attachments.map((a) => a.filename ?? a.mime).join("、");
  return `\n\n（原附件没有随接力带过来：${names}）`;
}

/** 校验并导入一份外来的接力数据（raw 是 JSON.parse 后的任意值）。 */
export function importRelaySession(raw: unknown, opts: RelayImportOptions = {}): RelayImportResult {
  const parsed = parseRelayFile(raw);
  if (!parsed.ok) throw new RelayError(400, parsed.error);
  const file = parsed.file;
  const from = opts.from ?? null;
  if (from !== null && !RELAY_MACHINE_RE.test(from)) throw new RelayError(400, "from 必须是机器名（小写字母 / 数字 / 连字符）");

  let workspacePath: string | null = null;
  if (opts.workspacePath) {
    if (!path.isAbsolute(opts.workspacePath)) throw new RelayError(400, "workspacePath 必须是绝对路径");
    let isDir = false;
    try {
      isDir = fs.statSync(opts.workspacePath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new RelayError(400, "workspacePath 在本机不存在或不是目录");
    workspacePath = opts.workspacePath;
  }
  const mode: "chat" | "project" = workspacePath ? "project" : "chat";

  const now = opts.now ?? Date.now();
  const sessionId = crypto.randomUUID();
  // 节点 created_at 保留原时刻，但强制严格递增：getSessionNodes 等按 created_at 排序，
  // 源机器的时钟 / 同毫秒写入不该让链在这里乱序。
  let lastAt = -1;
  const nodes: RelayNodeInsert[] = [];
  file.messages.forEach((m, i) => {
    const createdAt = Math.max(Math.min(m.createdAt, now), lastAt + 1);
    lastAt = createdAt;
    const toolCalls: ToolCall[] = m.toolCalls.map((t, j) => ({
      id: `relay-${i}-${j}`,
      name: t.name,
      input: { description: t.summary },
      output: null,
      stderr: null,
      status: t.status,
      durationMs: null,
      startedAt: createdAt,
      endedAt: createdAt,
    }));
    nodes.push({
      id: crypto.randomUUID(),
      parentId: i === 0 ? null : nodes[i - 1].id,
      kind: m.kind,
      question: m.kind === "reference" ? "" : m.question + attachmentNote(m),
      response: m.kind === "reference" ? "" : m.response,
      status: m.status,
      errorMessage: m.status === "error" ? (m.errorMessage ?? "error") : null,
      createdAt,
      // reference 是浮动根，没有 anchor；首个 qa 若接在 reference 后面，anchor 原样保留。
      parentAnchorText: i === 0 ? null : m.parentAnchor,
      topicLabel: m.topicLabel,
      toolCallsJson: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      reference: m.reference
        ? {
            sourceType: m.reference.sourceType,
            sourceUri: m.reference.sourceUri,
            contentMd: m.reference.contentMd,
            metaJson: JSON.stringify(m.reference.title ? { title: m.reference.title } : {}),
          }
        : null,
    });
  });

  const agent = file.session.agentSlug ? getAgentBySlug(file.session.agentSlug) : null;
  const meta: RelayMeta = {
    version: 1,
    from,
    sourceSessionId: file.source.sessionId,
    sourceLeafNodeId: file.source.leafNodeId,
    exportedAt: file.exportedAt,
    importedAt: now,
    workspaceName: file.source.workspaceName,
    importedNodeIds: nodes.map((n) => n.id),
  };
  const title = relayTitle(file.session.title, from);
  createRelaySession({
    sessionId,
    title,
    now,
    mode,
    workspacePath,
    systemPrompt: mode === "chat" ? file.session.systemPrompt : null,
    model: file.session.model && isProviderId(file.session.model) ? file.session.model : null,
    requireApproval: mode === "project" && file.session.requireApproval,
    agentId: agent && agent.enabled ? agent.id : null,
    relayJson: JSON.stringify(meta),
    nodes,
  });
  const leafNodeId = nodes[nodes.length - 1].id;
  return {
    sessionId,
    leafNodeId,
    path: `/?session=${encodeURIComponent(sessionId)}&node=${encodeURIComponent(leafNodeId)}`,
    title,
    mode,
  };
}

function relayMetaOf(sessionId: string): RelayMeta | null {
  const raw = getSessionRelayJson(sessionId);
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<RelayMeta>;
  return Array.isArray(m.importedNodeIds) ? (m as RelayMeta) : null;
}

/** 接力折叠历史的字符预算（≈ 中文 token 数）。超了从最老的轮次开始丢。 */
const RELAY_HISTORY_BUDGET = 240_000;
const RELAY_REF_EXCERPT = 20_000;

/**
 * 接力会话里某一轮的完整折叠历史（根 → 父，不含 nodeId 自身）。
 * 返回 null = 不是接力会话 / 祖先链上没有导入的节点（交给原有的折叠 / resume 逻辑）。
 *
 * 只在路由判定「这一轮不会 resume 任何 CLI session」时调用：导入的节点没有 resume id，
 * 第一轮必然 fresh；之后的轮次 resume 第一轮建起来的 CLI session（那里已经带着这份折叠
 * 历史），不会再走到这里。
 */
export function buildRelayHistory(nodeId: string): ChatMessage[] | null {
  const self = getNode(nodeId);
  if (!self) return null;
  const meta = relayMetaOf(self.sessionId);
  if (!meta) return null;
  const imported = new Set(meta.importedNodeIds);
  const chain = getNodeChain(nodeId).slice(0, -1);
  if (!chain.some((n) => imported.has(n.id))) return null;

  // 每轮一组（user + assistant），按组丢弃，别把一问一答拆开。
  const groups: ChatMessage[][] = chain.map((n) => {
    if (n.kind === "reference" && n.reference) {
      const title = n.reference.meta.title ? `《${n.reference.meta.title}》` : "";
      const body = clip(n.reference.contentMd, RELAY_REF_EXCERPT);
      return [{ role: "user", content: `以下是用户附带的参考材料${title}：\n\n${body}` }];
    }
    const msgs: ChatMessage[] = [{ role: "user", content: readableNodeRefs(n.question) }];
    let answer = n.response;
    const tools = n.toolCalls.filter((t) => !t.parentToolUseId);
    if (tools.length > 0) {
      const lines = tools.slice(0, 30).map((t) => {
        const desc = (t.input as { description?: unknown } | null)?.description;
        const s = imported.has(n.id) && typeof desc === "string" ? desc : (toolSummary(t) ?? toolTitle(t));
        return `- ${clip(s, 200)}${t.status === "error" ? "（失败）" : ""}`;
      });
      if (tools.length > 30) lines.push(`- ……另有 ${tools.length - 30} 次工具调用`);
      answer = `${answer}\n\n[这一轮调用过的工具]\n${lines.join("\n")}`.trim();
    }
    if (n.status === "error") answer = `${answer}\n\n（这一轮没有正常完成：${n.errorMessage ?? "error"}）`.trim();
    if (answer) msgs.push({ role: "assistant", content: answer });
    return msgs;
  });

  let total = 0;
  let keepFrom = groups.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const size = groups[i].reduce((s, m) => s + m.content.length, 0);
    if (total + size > RELAY_HISTORY_BUDGET && keepFrom < groups.length) break;
    total += size;
    keepFrom = i;
  }
  const dropped = keepFrom;
  const from = meta.from ? `机器「${meta.from}」` : "另一台机器";
  const header: ChatMessage = {
    role: "user",
    content:
      `（说明：这段对话是从${from}接力过来的。原机器上的附件、工作区文件和工具执行环境都没有带过来，` +
      `下面只是文字记录${dropped > 0 ? `；更早的 ${dropped} 轮因长度上限已省略` : ""}。）`,
  };
  return [header, ...groups.slice(keepFrom).flat()];
}
