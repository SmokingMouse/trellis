// C1 (Wave 3): Trellis command palette registry.
//
// These are *client-local* session meta-operations — unlike /skill commands
// (which are forwarded to the claude CLI for execution), a Trellis command runs
// against the zustand store directly and is NEVER sent to the LLM. The "/"
// dropdown in QuestionInput surfaces these alongside skills; the submit handler
// intercepts a bare Trellis command and runs it instead of streamRoot.
//
// Mirrors useSkillSuggestions' prefix-match style so the two merge cleanly in
// one dropdown. Commands are first-class (available in every mode); skills are
// only shown in tool-capable modes.

import { PROVIDERS, isProviderId, type ProviderId } from "@/lib/llm";

// Minimal slice of the store the commands touch — keeps commands.ts free of a
// direct dependency on the store module (which would pull in browser-only
// stream code). QuestionInput passes get()/the store object that satisfies it.
export type CommandStore = {
  session: { id: string } | null;
  newConversation: () => void;
  archiveSession: (sessionId: string) => Promise<void> | void;
  setSearchOpen: (open: boolean) => void;
  setComposeRootOpen: (open: boolean) => void;
  setProvider: (provider: ProviderId) => void;
};

export type Command = {
  name: string;
  description: string;
  // Optional usage hint (e.g. argument shape) shown after the description.
  hint?: string;
  // Whether this command needs a currently-loaded session. The dropdown still
  // shows it (so it's discoverable) but run() no-ops with a console note when
  // there's no session.
  requiresSession?: boolean;
  // Execute the command. `args` is the trimmed text after the command name
  // (e.g. for "/model opus" → "opus"). Return a short user-facing note when the
  // command was a no-op so callers can surface it; void otherwise.
  run: (store: CommandStore, args: string) => string | void;
};

export const COMMANDS: Command[] = [
  {
    name: "new",
    description: "开一个全新 session（清空到首屏新建态）",
    run: (store) => {
      store.newConversation();
    },
  },
  {
    name: "clear",
    description: "当前 session 内起一个清空上下文的新话题 🧹",
    requiresSession: true,
    run: (store) => {
      if (!store.session) return "没有当前 session — 先开一个对话再 /clear";
      store.setComposeRootOpen(true);
    },
  },
  {
    name: "archive",
    description: "归档当前 session（从 tab 条隐藏，可恢复）",
    requiresSession: true,
    run: (store) => {
      const id = store.session?.id;
      if (!id) return "没有当前 session 可归档";
      void store.archiveSession(id);
    },
  },
  {
    name: "model",
    description: "切换模型",
    hint: "<name>，如 claude-opus / claude-sonnet / claude-haiku / codex",
    run: (store, args) => {
      const raw = args.trim().toLowerCase();
      if (!raw) {
        const ids = PROVIDERS.map((p) => p.id).join(" / ");
        return `用法：/model <name> — 可选 ${ids}`;
      }
      const id = resolveProvider(raw);
      if (!id) {
        const ids = PROVIDERS.map((p) => p.id).join(" / ");
        return `未知模型「${args.trim()}」— 可选 ${ids}`;
      }
      store.setProvider(id);
    },
  },
  {
    name: "switch",
    description: "打开跨 session 切换（搜索）面板",
    run: (store) => {
      store.setSearchOpen(true);
    },
  },
];

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));

// prefix-match against the leading "/name" token (same shape as
// useSkillSuggestions): text must start with "/" and have no space yet.
export function matchCommands(text: string): Command[] {
  if (!text.startsWith("/") || text.includes(" ")) return [];
  const q = text.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.toLowerCase().includes(q));
}

// Parse a submitted input into a Trellis command + its args, or null if the
// input isn't a bare Trellis command. "Bare" = the first whitespace-delimited
// token (sans leading "/") is a known command name. This is what the submit
// handler uses to decide local-execute vs send-to-LLM.
export function parseCommand(
  text: string,
): { command: Command; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.search(/\s/);
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx))
    .toLowerCase();
  if (!COMMAND_NAMES.has(name)) return null;
  const command = COMMANDS.find((c) => c.name === name)!;
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return { command, args };
}

// Map a user-typed model token to a ProviderId. Accepts the full id
// ("claude-opus"), a bare family/short label ("opus", "sonnet", "haiku",
// "codex"), or anything that uniquely prefix-matches a provider id/shortLabel.
function resolveProvider(raw: string): ProviderId | null {
  if (isProviderId(raw)) return raw;
  // shortLabel match (e.g. "opus" → claude-opus, "codex" → codex).
  const byShort = PROVIDERS.find(
    (p) => p.shortLabel.toLowerCase() === raw,
  );
  if (byShort) return byShort.id;
  // bare family suffix: "opus" matches "claude-opus".
  const bySuffix = PROVIDERS.filter((p) =>
    p.id.toLowerCase().endsWith(`-${raw}`),
  );
  if (bySuffix.length === 1) return bySuffix[0].id;
  // unique prefix of the id.
  const byPrefix = PROVIDERS.filter((p) => p.id.toLowerCase().startsWith(raw));
  if (byPrefix.length === 1) return byPrefix[0].id;
  return null;
}
