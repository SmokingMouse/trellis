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

type TurnDraft = ParsedTurn & {
  eventText: string[];
  responseText: string[];
  seenResponseIds: Set<string>;
  toolByCallId: Map<string, ToolCall>;
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

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
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
    .filter(Boolean)
    .join("\n");
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
    turnOrdinal: ordinal,
    eventText: [],
    responseText: [],
    seenResponseIds: new Set(),
    toolByCallId: new Map(),
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
  const pendingTools = new Map<string, ToolCall>();
  let activeTurnId: string | null = null;
  let latestTimestamp = ms(meta?.timestamp);

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
        const question = stringValue(payload?.message);
        if (!question) continue;
        let id = activeTurnId;
        if (!id || byTurnId.has(id)) {
          id = crypto
            .createHash("sha256")
            .update(`${sessionId}:${drafts.length + 1}:${question}`)
            .digest("hex")
            .slice(0, 32);
        }
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
        continue;
      }

      const active = activeTurnId ? byTurnId.get(activeTurnId) : undefined;
      if (!active) continue;
      if (eventType === "agent_message") {
        const text = stringValue(payload?.message);
        if (text) active.eventText.push(text);
      } else if (eventType === "token_count") {
        const info = payload?.info;
        const last =
          info && typeof info === "object"
            ? ((info as JsonObject).last_token_usage as Usage | undefined)
            : undefined;
        if (last) {
          const totalInput = last.input_tokens ?? 0;
          const cached = last.cached_input_tokens ?? 0;
          active.tokens = {
            input: Math.max(0, totalInput - cached),
            output: last.output_tokens ?? 0,
            cacheRead: cached,
            cacheCreation: last.cache_write_input_tokens ?? 0,
            contextTokens: totalInput,
          };
        }
      }
      continue;
    }

    if (entry.type !== "response_item" || !payload) continue;
    const itemType = stringValue(payload.type);
    const itemTurnId = turnIdFromPayload(payload) ?? activeTurnId;
    const turn = itemTurnId ? byTurnId.get(itemTurnId) : undefined;
    if (!turn || !itemType) continue;

    if (itemType === "message" && payload.role === "assistant") {
      const text = contentText(payload.content).trim();
      const responseId = stringValue(payload.id) ?? `${itemTurnId}:${turn.responseText.length}`;
      if (text && !turn.seenResponseIds.has(responseId)) {
        turn.seenResponseIds.add(responseId);
        turn.responseText.push(text);
      }
      continue;
    }

    if (itemType === "custom_tool_call" || itemType === "function_call") {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (!callId) continue;
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
      turn.toolByCallId.set(callId, call);
      pendingTools.set(callId, call);
      continue;
    }

    if (itemType === "custom_tool_call_output" || itemType === "function_call_output") {
      const callId = stringValue(payload.call_id);
      if (!callId) continue;
      const call = pendingTools.get(callId);
      if (call) {
        call.output = toolOutput(payload.output);
        call.endedAt = at;
        call.durationMs = Math.max(0, at - call.startedAt);
      }
    }
  }

  if (drafts.length === 0) return null;
  const turns = drafts.map((draft) => {
    draft.response = (
      draft.responseText.length > 0 ? draft.responseText : draft.eventText
    ).join("\n\n");
    draft.toolCalls = [...draft.toolByCallId.values()];
    const turn: ParsedTurn = {
      id: draft.id,
      parentId: draft.parentId,
      siblingIndex: draft.siblingIndex,
      question: draft.question,
      response: draft.response,
      toolCalls: draft.toolCalls,
      tokens: draft.tokens,
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
