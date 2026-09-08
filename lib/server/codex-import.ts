// Codex rollout jsonl -> Trellis Q/A turns. Pure parser: no DB and no
// server-only import, so the real-corpus harness can run it directly.
import fs from "node:fs";
import crypto from "node:crypto";
import type { ToolCall } from "@/lib/types";
import type { ParsedCliSession, ParsedTurn } from "./cli-import";

type JsonObject = Record<string, unknown>;
type RolloutEntry = {
  timestamp?: string;
  type?: string;
  payload?: JsonObject;
};

type Usage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
};

type ResponsePart = {
  text: string;
  final: boolean;
};

type TurnDraft = ParsedTurn & {
  eventText: string[];
  responseParts: ResponsePart[];
  seenResponseIds: Set<string>;
  toolByCallId: Map<string, ToolCall>;
  latestTimestamp: number;
  completedDurationMs: number | null;
  pendingFinalBreak: boolean;
};

function ms(value: unknown): number {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const block = item as JsonObject;
      return typeof block.text === "string"
        ? block.text
        : typeof block.content === "string"
          ? block.content
          : "";
    })
    .filter(Boolean);
}

function contentText(content: unknown): string {
  return contentTexts(content).join("\n");
}

const HARNESS_USER_PREFIX =
  /^(?:#\s*AGENTS\.md instructions\b|<(?:AGENTS\.md|system-reminder|task-notification|environment_context)(?:\s|>))/i;

function visibleUserText(content: unknown): string | null {
  const visible = contentTexts(content)
    .filter((text) => !HARNESS_USER_PREFIX.test(text.trimStart()))
    .join("\n")
    .trim();
  return visible || null;
}

function parseInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function turnIdFromPayload(payload: JsonObject | undefined): string | null {
  if (!payload) return null;
  const direct = stringValue(payload.turn_id);
  if (direct) return direct;
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!meta || typeof meta !== "object") return null;
  return stringValue((meta as JsonObject).turn_id);
}

function toolOutput(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = contentText(value);
    return text || JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createTurn(
  id: string,
  parentId: string | null,
  question: string,
  createdAt: number,
  ordinal: number,
): TurnDraft {
  return {
    id,
    parentId,
    siblingIndex: 0,
    question,
    response: "",
    toolCalls: [],
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      contextTokens: null,
    },
    createdAt,
    durationMs: 0,
    turnOrdinal: ordinal,
    eventText: [],
    responseParts: [],
    seenResponseIds: new Set(),
    toolByCallId: new Map(),
    latestTimestamp: createdAt,
    completedDurationMs: null,
    pendingFinalBreak: false,
  };
}

export function parseCodexSessionJsonl(
  jsonlPath: string,
): ParsedCliSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }

  const entries: RolloutEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RolloutEntry);
    } catch {
      // Codex appends while running; an incomplete final line is expected.
    }
  }
  const meta = entries.find((entry) => entry.type === "session_meta")?.payload;
  const fallbackSid = jsonlPath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  )?.[1];
  const sessionId =
    stringValue(meta?.id) ?? stringValue(meta?.session_id) ?? fallbackSid ?? null;
  if (!sessionId) return null;

  const cwd = stringValue(meta?.cwd);
  const git = meta?.git;
  const gitBranch =
    git && typeof git === "object" ? stringValue((git as JsonObject).branch) : null;

  const drafts: TurnDraft[] = [];
  const byTurnId = new Map<string, TurnDraft>();
  const pendingTools = new Map<string, { turn: TurnDraft; call: ToolCall }>();
  const pendingToolOutputs = new Map<
    string,
    { output: string | null; at: number; isError: boolean }
  >();
  let activeTurnId: string | null = null;
  let latestTimestamp = ms(meta?.timestamp);

  const startUserTurn = (
    question: string,
    at: number,
    explicitTurnId: string | null,
  ): TurnDraft => {
    if (explicitTurnId) {
      const existing = byTurnId.get(explicitTurnId);
      // Some Codex releases emit the same visible user message through both
      // response_item and event_msg. One runtime turn must stay one Trellis turn.
      if (existing) {
        activeTurnId = existing.id;
        return existing;
      }
    }
    const unusedActiveId =
      !explicitTurnId && activeTurnId && !byTurnId.has(activeTurnId)
        ? activeTurnId
        : null;
    const id =
      explicitTurnId ??
      unusedActiveId ??
      crypto
        .createHash("sha256")
        .update(`${sessionId}:${drafts.length + 1}:${question}`)
        .digest("hex")
        .slice(0, 32);
    const turn = createTurn(
      id,
      drafts.at(-1)?.id ?? null,
      question,
      at,
      drafts.length + 1,
    );
    drafts.push(turn);
    byTurnId.set(id, turn);
    activeTurnId = id;
    return turn;
  };

  for (const entry of entries) {
    const payload = entry.payload;
    const at = ms(entry.timestamp ?? payload?.timestamp);
    if (at > latestTimestamp) latestTimestamp = at;

    if (entry.type === "turn_context") {
      activeTurnId = turnIdFromPayload(payload) ?? activeTurnId;
      continue;
    }
    if (entry.type === "event_msg") {
      const eventType = stringValue(payload?.type);
      if (eventType === "task_started") {
        activeTurnId = turnIdFromPayload(payload) ?? activeTurnId;
        continue;
      }
      if (eventType === "user_message") {
        const question = visibleUserText(payload?.message);
        if (!question) continue;
        startUserTurn(question, at, turnIdFromPayload(payload));
        continue;
      }

      const active = activeTurnId ? byTurnId.get(activeTurnId) : undefined;
      if (!active) continue;
      if (at > active.latestTimestamp) active.latestTimestamp = at;
      if (eventType === "agent_message") {
        const text = stringValue(payload?.message);
        if (text && !active.eventText.includes(text)) active.eventText.push(text);
      } else if (eventType === "task_complete") {
        const duration = finiteNumber(payload?.duration_ms);
        if (duration !== null) active.completedDurationMs = Math.max(0, duration);
        const text = stringValue(payload?.last_agent_message);
        if (text && !active.eventText.includes(text)) active.eventText.push(text);
      } else if (eventType === "token_count") {
        const info = payload?.info;
        if (info && typeof info === "object") {
          const infoObj = info as JsonObject;
          const usage = (infoObj.last_token_usage ?? infoObj.total_token_usage) as
            | Usage
            | undefined;
          if (usage) {
            const totalInput = usage.input_tokens ?? 0;
            const cached = usage.cached_input_tokens ?? 0;
            active.tokens = {
              input: Math.max(0, totalInput - cached),
              output: usage.output_tokens ?? 0,
              cacheRead: cached,
              cacheCreation: usage.cache_write_input_tokens ?? 0,
              contextTokens: totalInput,
            };
          }
        }
      }
      continue;
    }

    if (entry.type !== "response_item" || !payload) continue;
    const itemType = stringValue(payload.type);
    const itemTurnId = turnIdFromPayload(payload) ?? activeTurnId;

    if (itemType === "message" && payload.role === "user") {
      const question = visibleUserText(payload.content);
      if (question) {
        startUserTurn(question, at, turnIdFromPayload(payload));
      }
      continue;
    }

    const turn = itemTurnId ? byTurnId.get(itemTurnId) : undefined;
    if (!turn || !itemType) continue;
    if (at > turn.latestTimestamp) turn.latestTimestamp = at;

    if (itemType === "message" && payload.role === "assistant") {
      const text = contentText(payload.content).trim();
      const phase = stringValue(payload.phase);
      const responseId =
        stringValue(payload.id) ??
        crypto
          .createHash("sha256")
          .update(`${itemTurnId}:${phase ?? ""}:${text}`)
          .digest("hex");
      if (text && !turn.seenResponseIds.has(responseId)) {
        turn.seenResponseIds.add(responseId);
        turn.responseParts.push({
          text,
          final:
            phase === "final_answer" ||
            (turn.pendingFinalBreak && phase !== "commentary"),
        });
        turn.pendingFinalBreak = false;
      }
      continue;
    }

    if (itemType === "reasoning") {
      if (turn.responseParts.length > 0) turn.pendingFinalBreak = true;
      continue;
    }

    if (itemType === "custom_tool_call" || itemType === "function_call") {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (!callId) continue;
      if (turn.responseParts.length > 0) turn.pendingFinalBreak = true;
      const call: ToolCall = {
        id: callId,
        name: stringValue(payload.name) ?? "tool",
        input: parseInput(payload.input ?? payload.arguments),
        output: null,
        stderr: null,
        status: "done",
        durationMs: null,
        startedAt: at,
        endedAt: at,
      };
      const completed = pendingToolOutputs.get(callId);
      if (completed) {
        call.output = completed.output;
        call.status = completed.isError ? "error" : "done";
        call.endedAt = completed.at;
        call.durationMs = Math.max(0, completed.at - call.startedAt);
        pendingToolOutputs.delete(callId);
      }
      turn.toolByCallId.set(callId, call);
      pendingTools.set(callId, { turn, call });
      continue;
    }

    if (itemType === "custom_tool_call_output" || itemType === "function_call_output") {
      const callId = stringValue(payload.call_id);
      if (!callId) continue;
      const pending = pendingTools.get(callId);
      const output = toolOutput(payload.output);
      const isError = payload.status === "failed" || payload.is_error === true;
      if (pending) {
        const { call, turn: owner } = pending;
        call.output = output;
        call.status = isError ? "error" : "done";
        call.endedAt = at;
        call.durationMs = Math.max(0, at - call.startedAt);
        if (at > owner.latestTimestamp) owner.latestTimestamp = at;
      } else {
        pendingToolOutputs.set(callId, { output, at, isError });
      }
    }
  }

  if (drafts.length === 0) return null;
  const turns = drafts.map((draft) => {
    const responseText = draft.responseParts.map((part) => part.text);
    draft.response = (responseText.length > 0 ? responseText : draft.eventText).join(
      "\n\n",
    );
    draft.toolCalls = [...draft.toolByCallId.values()];
    const finalPartIdx = draft.responseParts.findIndex((part) => part.final);
    const turn: ParsedTurn = {
      id: draft.id,
      parentId: draft.parentId,
      siblingIndex: draft.siblingIndex,
      question: draft.question,
      response: draft.response,
      finalStart:
        finalPartIdx > 0
          ? responseText.slice(0, finalPartIdx).join("\n\n").length + 2
          : 0,
      toolCalls: draft.toolCalls,
      tokens: draft.tokens,
      durationMs:
        draft.completedDurationMs ??
        Math.max(0, draft.latestTimestamp - draft.createdAt),
      createdAt: draft.createdAt,
      turnOrdinal: draft.turnOrdinal,
    };
    return turn;
  });
  const created = turns.map((turn) => turn.createdAt).filter((value) => value > 0);
  const title = turns[0].question.replace(/\s+/g, " ").trim().slice(0, 60) || "未命名会话";
  return {
    sessionId,
    cwd,
    gitBranch,
    title,
    createdAt: created.length ? Math.min(...created) : latestTimestamp,
    updatedAt: latestTimestamp || (created.length ? Math.max(...created) : 0),
    // The field name is legacy. For Codex this is an append cursor, not a UUID.
    lastUuid: `${Buffer.byteLength(raw)}:${entries.length}`,
    entryUuids: turns.map((turn) => turn.id),
    turns,
  };
}
