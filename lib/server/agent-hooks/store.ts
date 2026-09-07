import "server-only";
import { getDB } from "@/lib/server/sqlite";
import { applyHookEvent, type NormalizeOptions } from "./normalize";
import type { AgentHookRecord, ClaudeHookPayload, StashedState } from "./types";

export const HOOK_RETENTION_MS = 24 * 60 * 60_000;
export const HOOK_FIELD_MAX_BYTES = 32 * 1024;

function boundedText(text: string | null, limit = HOOK_FIELD_MAX_BYTES): string | null {
  if (text === null || Buffer.byteLength(text) <= limit) return text;
  // Streaming decode drops an incomplete final UTF-8 codepoint.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, limit), { stream: true });
}

function boundedJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= HOOK_FIELD_MAX_BYTES) return json;
  // A JSON character can escape to six bytes. Leave room for the envelope.
  return JSON.stringify({ truncated: true, preview: boundedText(json, Math.floor((HOOK_FIELD_MAX_BYTES - 64) / 6)) });
}

export type HookSummary = Pick<AgentHookRecord, "sessionId" | "state" | "toolName" | "interactivePrompt" | "paneKey" | "updatedAt">;

export function listHookSummaries(): HookSummary[] {
  pruneHookRecords();
  const rows = getDB().prepare(`SELECT session_id, state, tool_name, interactive_prompt, pane_key, updated_at
    FROM agent_hook_state ORDER BY updated_at DESC, session_id`).all() as Pick<Row, "session_id" | "state" | "tool_name" | "interactive_prompt" | "pane_key" | "updated_at">[];
  return rows.map(row => ({
    sessionId: row.session_id, state: row.state as AgentHookRecord["state"], toolName: row.tool_name,
    interactivePrompt: parse<unknown>(row.interactive_prompt, null), paneKey: row.pane_key, updatedAt: row.updated_at,
  }));
}

export function pruneHookRecords(now = Date.now()): number {
  return getDB().prepare("DELETE FROM agent_hook_state WHERE updated_at < ?").run(now - HOOK_RETENTION_MS).changes;
}

type Row = {
  session_id: string;
  agent: string;
  state: string;
  prompt: string | null;
  tool_name: string | null;
  tool_input: string | null;
  interactive_prompt: string | null;
  last_assistant_message: string | null;
  transcript_path: string | null;
  cwd: string | null;
  pane_key: string | null;
  subagents: string;
  stashed: string | null;
  updated_at: number;
  state_started_at: number;
};

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: Row): AgentHookRecord {
  return {
    sessionId: row.session_id,
    agent: "claude",
    state: row.state as AgentHookRecord["state"],
    prompt: row.prompt,
    toolName: row.tool_name,
    toolInput: parse<unknown>(row.tool_input, null),
    interactivePrompt: parse<unknown>(row.interactive_prompt, null),
    lastAssistantMessage: row.last_assistant_message,
    transcriptPath: row.transcript_path,
    cwd: row.cwd,
    paneKey: row.pane_key,
    subagents: parse<string[]>(row.subagents, []),
    stashed: parse<StashedState | null>(row.stashed, null),
    updatedAt: row.updated_at,
    stateStartedAt: row.state_started_at,
  };
}

export function getHookRecord(sessionId: string): AgentHookRecord | null {
  const row = getDB()
    .prepare("SELECT * FROM agent_hook_state WHERE session_id = ?")
    .get(sessionId) as Row | null;
  return row ? toRecord(row) : null;
}

export function listHookRecords(): AgentHookRecord[] {
  pruneHookRecords();
  const rows = getDB()
    .prepare("SELECT * FROM agent_hook_state ORDER BY updated_at DESC")
    .all() as Row[];
  return rows.map(toRecord);
}

export function saveHookRecord(rec: AgentHookRecord): void {
  getDB()
    .prepare(
      `INSERT INTO agent_hook_state
         (session_id, agent, state, prompt, tool_name, tool_input,
          interactive_prompt, last_assistant_message, transcript_path, cwd,
          pane_key, subagents, stashed, updated_at, state_started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         agent = excluded.agent,
         state = excluded.state,
         prompt = excluded.prompt,
         tool_name = excluded.tool_name,
         tool_input = excluded.tool_input,
         interactive_prompt = excluded.interactive_prompt,
         last_assistant_message = excluded.last_assistant_message,
         transcript_path = excluded.transcript_path,
         cwd = excluded.cwd,
         pane_key = excluded.pane_key,
         subagents = excluded.subagents,
         stashed = excluded.stashed,
         updated_at = excluded.updated_at,
         state_started_at = excluded.state_started_at`,
    )
    .run(
      rec.sessionId,
      rec.agent,
      rec.state,
      rec.prompt,
      rec.toolName,
      boundedJson(rec.toolInput),
      boundedJson(rec.interactivePrompt),
      boundedText(rec.lastAssistantMessage),
      rec.transcriptPath,
      rec.cwd,
      rec.paneKey,
      JSON.stringify(rec.subagents),
      rec.stashed ? JSON.stringify({
        ...rec.stashed,
        toolInput: parse<unknown>(boundedJson(rec.stashed.toolInput), null),
        interactivePrompt: parse<unknown>(boundedJson(rec.stashed.interactivePrompt), null),
      }) : null,
      rec.updatedAt,
      rec.stateStartedAt,
    );
}

/** 收到一条 hook：读现状 → 归一化 → 落库。返回落库后的记录（payload 无 session_id → null）。 */
export function recordClaudeHook(
  payload: ClaudeHookPayload,
  opts: NormalizeOptions = {},
): AgentHookRecord | null {
  const sessionId =
    typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return null;
  pruneHookRecords(opts.now);
  const next = applyHookEvent(getHookRecord(sessionId), payload, opts);
  if (!next) return null;
  saveHookRecord(next);
  return next;
}
