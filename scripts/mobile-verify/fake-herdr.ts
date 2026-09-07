import fs from "node:fs";
import path from "node:path";

type RequestEnvelope = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

const socketPath = process.env.HERDR_SOCKET_PATH ?? "";
const requestLog = process.env.FAKE_HERDR_LOG ?? "";
const fakeHome = process.env.FAKE_HERDR_HOME ?? "";
if (!socketPath || !requestLog || !fakeHome) {
  throw new Error(
    "HERDR_SOCKET_PATH, FAKE_HERDR_LOG and FAKE_HERDR_HOME are required",
  );
}

const cwd = path.join(fakeHome, "workspace");
const claudeSession = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const codexSession = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const claudeTranscript = path.join(
  fakeHome,
  ".claude",
  "projects",
  "fake-herdr",
  `${claudeSession}.jsonl`,
);
const codexTranscript = path.join(
  fakeHome,
  ".codex",
  "sessions",
  "2026",
  "09",
  "07",
  `rollout-fake-${codexSession}.jsonl`,
);

fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.dirname(claudeTranscript), { recursive: true });
fs.mkdirSync(path.dirname(codexTranscript), { recursive: true });
fs.writeFileSync(
  claudeTranscript,
  [
    {
      type: "user",
      uuid: "claude-user-1",
      parentUuid: null,
      sessionId: claudeSession,
      cwd,
      timestamp: "2026-09-07T09:00:00.000Z",
      message: { role: "user", content: "HERDR_CLAUDE_QUESTION" },
    },
    {
      type: "assistant",
      uuid: "claude-assistant-1",
      parentUuid: "claude-user-1",
      sessionId: claudeSession,
      cwd,
      timestamp: "2026-09-07T09:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "HERDR_CLAUDE_ANSWER" }],
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n",
);

const codexLine = (timestamp: string, type: string, payload: object) =>
  JSON.stringify({ timestamp, type, payload });
fs.writeFileSync(
  codexTranscript,
  [
    codexLine("2026-09-07T10:00:00.000Z", "session_meta", {
      id: codexSession,
      session_id: codexSession,
      timestamp: "2026-09-07T10:00:00.000Z",
      cwd,
    }),
    codexLine("2026-09-07T10:00:01.000Z", "turn_context", {
      turn_id: "codex-turn-1",
      cwd,
    }),
    codexLine("2026-09-07T10:00:02.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "HERDR_CODEX_QUESTION" }],
      internal_chat_message_metadata_passthrough: { turn_id: "codex-turn-1" },
    }),
    codexLine("2026-09-07T10:00:03.000Z", "response_item", {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "HERDR_CODEX_ANSWER" }],
      internal_chat_message_metadata_passthrough: { turn_id: "codex-turn-1" },
    }),
    codexLine("2026-09-07T10:00:04.000Z", "event_msg", {
      type: "task_complete",
      turn_id: "codex-turn-1",
      duration_ms: 2000,
      last_agent_message: "HERDR_CODEX_ANSWER",
    }),
  ].join("\n") + "\n",
);

fs.rmSync(socketPath, { force: true });
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
fs.writeFileSync(requestLog, "");

const panes = [
  {
    pane_id: "pane-claude",
    terminal_id: "term-claude",
    workspace_id: "workspace-fake",
    tab_id: "tab-fake",
    focused: true,
    agent: "claude",
    agent_session: {
      source: "herdr:claude",
      agent: "claude",
      kind: "id",
      value: claudeSession,
    },
    agent_status: "idle",
    cwd,
    label: "Claude 审阅",
    terminal_title: "claude",
    revision: 1,
  },
  {
    pane_id: "pane-codex",
    terminal_id: "term-codex",
    workspace_id: "workspace-fake",
    tab_id: "tab-fake",
    focused: false,
    agent: "codex",
    agent_session: {
      source: "herdr:codex",
      agent: "codex",
      kind: "id",
      value: codexSession,
    },
    agent_status: "blocked",
    cwd,
    label: "Codex 构建",
    terminal_title: "codex",
    revision: 1,
  },
];

const subscribers = new Set<Bun.Socket<{ buffer: string }>>();

function resultFor(request: RequestEnvelope): Record<string, unknown> {
  switch (request.method) {
    case "ping":
      return {
        type: "pong",
        version: "fake-mobile-verify",
        protocol: 19,
        capabilities: {},
      };
    case "session.snapshot":
      return {
        type: "session_snapshot",
        snapshot: {
          version: "fake-mobile-verify",
          protocol: 19,
          focused_workspace_id: "workspace-fake",
          focused_tab_id: "tab-fake",
          focused_pane_id: "pane-claude",
          workspaces: [
            { workspace_id: "workspace-fake", label: "Fake Workspace" },
          ],
          tabs: [
            {
              tab_id: "tab-fake",
              workspace_id: "workspace-fake",
              label: "Agents",
            },
          ],
          panes,
          layouts: [],
          agents: [
            { pane_id: "pane-claude", name: "reviewer", state_change_seq: 1 },
            { pane_id: "pane-codex", name: "builder", state_change_seq: 1 },
          ],
        },
      };
    case "pane.list":
      return { type: "pane_list", panes };
    case "pane.read":
      return {
        type: "pane_read",
        lines: Array.from(
          { length: 48 },
          (_, index) =>
            `${String(index + 1).padStart(2, "0")} fake terminal line${
              index === 47 ? " — Select option 1-3 or press Esc" : ""
            }`,
        ),
      };
    case "pane.split":
      return {
        type: "pane_info",
        pane: {
          ...panes[0],
          pane_id: "pane-reopened",
          terminal_id: "term-reopened",
          revision: 0,
        },
      };
    default:
      return { type: "ok" };
  }
}

const listener = Bun.listen({
  unix: socketPath,
  data: { buffer: "" },
  socket: {
    data(socket, chunk) {
      socket.data.buffer += chunk.toString();
      while (true) {
        const newline = socket.data.buffer.indexOf("\n");
        if (newline < 0) return;
        const line = socket.data.buffer.slice(0, newline);
        socket.data.buffer = socket.data.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as RequestEnvelope;
        fs.appendFileSync(requestLog, `${JSON.stringify(request)}\n`);
        if (request.method === "events.subscribe") {
          subscribers.add(socket);
          socket.write(
            `${JSON.stringify({
              id: request.id,
              result: { type: "subscription_started" },
            })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({ id: request.id, result: resultFor(request) })}\n`,
        );
      }
    },
    close(socket) {
      subscribers.delete(socket);
    },
  },
});

function stop() {
  for (const socket of subscribers) socket.end();
  listener.stop(true);
  fs.rmSync(socketPath, { force: true });
  process.exit(0);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(`fake Herdr listening on ${socketPath}`);
