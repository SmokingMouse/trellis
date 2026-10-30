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

import {
  PROVIDERS,
  blockedFamilySwitch,
  type ProviderId,
  type ProviderInfo,
} from "@/lib/llm";
import { setThemeMode, setThemePalette } from "@/hooks/useTheme";
import { PALETTES, isPaletteId } from "@/lib/themes";
import { openKeyboardHelp } from "@/lib/shortcuts";

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
  // Current effective provider — the model the active session's next turn
  // would use. /model needs it for the session-family lock check.
  provider: ProviderId;
  // Live model catalog (GET /api/providers) — falls back to the static
  // PROVIDERS list when empty (e.g. store not yet hydrated).
  providerCatalog: ProviderInfo[];
  // 角色场景（scope = "role"）才用到的两样：开新话题时直接带上首句，以及 /remember
  // 按普通消息发出去。普通场景不传。
  streamRoot?: (question: string, opts: { attachToCurrentSession: true }) => unknown;
  sendMessage?: (text: string) => void;
};

/** 命令表的场景：角色对话里 `/new` 是新话题、多一个 `/remember`；其余场景照旧。 */
export type CommandScope = "default" | "role";

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
    description: "新会话：开一棵全新树（回首屏）",
    run: (store) => {
      store.newConversation();
    },
  },
  {
    name: "clear",
    description: "新话题：当前会话内清空上下文（树保留）",
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
    description: "切换模型（同系内；跨系请开新会话）",
    hint: "<name>，如 claude-opus / codex:gpt-5.5 / deepseek:deepseek-v4-flash",
    run: (store, args) => {
      const catalog = store.providerCatalog.length > 0 ? store.providerCatalog : PROVIDERS;
      const raw = args.trim().toLowerCase();
      if (!raw) {
        const ids = catalog.map((p) => p.id).join(" / ");
        return `用法：/model <name> — 可选 ${ids}`;
      }
      const id = resolveProvider(raw, catalog);
      if (!id) {
        const ids = catalog.map((p) => p.id).join(" / ");
        return `未知模型「${args.trim()}」— 可选 ${ids}`;
      }
      // Session-family lock: same rule as the ModelPicker UI. Resume ids are
      // family-scoped — a cross-family switch mid-session silently drops the
      // conversation context, so it's only allowed with no session loaded.
      if (store.session && blockedFamilySwitch(store.provider, id)) {
        return `「${id}」与当前会话不同系（claude/codex 上下文互不相通）— 跨系请 /new 开新会话`;
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
  {
    name: "help",
    description: "键盘快捷键一览",
    run: () => {
      openKeyboardHelp();
    },
  },
  {
    name: "theme",
    description: "切换外观（light/dark/system）或主题皮肤",
    hint: "<light|dark|system|主题名>，如 /theme dark、/theme paper",
    run: (_store, args) => {
      const raw = args.trim().toLowerCase();
      const paletteIds = PALETTES.map((p) => p.id);
      if (!raw) {
        return `用法：/theme <light|dark|system|${paletteIds.join("|")}>`;
      }
      if (raw === "light" || raw === "dark" || raw === "system") {
        setThemeMode(raw);
        return;
      }
      if (isPaletteId(raw)) {
        setThemePalette(raw);
        return;
      }
      return `未知主题「${args.trim()}」— 可选 light / dark / system / ${paletteIds.join(" / ")}`;
    },
  },
];

// 角色对话的命令表（docs/roles-p1.md）：角色只有一条时间线，没有「新会话」——
// `/new` 改成新话题（与 /clear 同一条路：当前会话里开一个新根，上下文重开、记忆不动）；
// `/remember <事>` 就是一句普通消息，加个「请记下：」前缀让角色按记忆规矩写文件。
// 其余命令沿用默认表（/clear 留着当 /new 的别名）。
export const REMEMBER_PREFIX = "请记下：";

const ROLE_ONLY: Command[] = [
  {
    name: "new",
    description: "新话题：从这里起上下文重新开始，记忆保留",
    hint: "可直接带上第一句，如 /new 帮我看下这个 PR",
    requiresSession: true,
    run: (store, args) => {
      if (!store.session) return "还没开始聊——直接说就是第一个话题";
      const first = args.trim();
      if (first && store.streamRoot) {
        void store.streamRoot(first, { attachToCurrentSession: true });
        return;
      }
      store.setComposeRootOpen(true);
    },
  },
  {
    name: "remember",
    description: "让它记下一件事",
    hint: "<要记的事>，如 /remember 报告多用表格",
    run: (store, args) => {
      const what = args.trim();
      if (!what) return "用法：/remember <要记的事>";
      if (!store.sendMessage) return "现在发不出消息";
      store.sendMessage(`${REMEMBER_PREFIX}${what}`);
    },
  },
];

const ROLE_COMMANDS: Command[] = [
  ...ROLE_ONLY,
  ...COMMANDS.filter((c) => !ROLE_ONLY.some((r) => r.name === c.name)),
];

/** 某个场景下的命令表。 */
export function commandsFor(scope: CommandScope = "default"): Command[] {
  return scope === "role" ? ROLE_COMMANDS : COMMANDS;
}

// prefix-match against the leading "/name" token (same shape as
// useSkillSuggestions): text must start with "/" and have no space yet.
export function matchCommands(text: string, scope: CommandScope = "default"): Command[] {
  if (!text.startsWith("/") || text.includes(" ")) return [];
  const q = text.slice(1).toLowerCase();
  return commandsFor(scope).filter((c) => c.name.toLowerCase().includes(q));
}

// Parse a submitted input into a Trellis command + its args, or null if the
// input isn't a bare Trellis command. "Bare" = the first whitespace-delimited
// token (sans leading "/") is a known command name. This is what the submit
// handler uses to decide local-execute vs send-to-LLM.
export function parseCommand(
  text: string,
  scope: CommandScope = "default",
): { command: Command; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.search(/\s/);
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx))
    .toLowerCase();
  const command = commandsFor(scope).find((c) => c.name === name);
  if (!command) return null;
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
  return { command, args };
}

// Map a user-typed model token to a ProviderId against a given catalog.
// Accepts the full id ("claude-opus", or a composite "deepseek:deepseek-v4-
// flash"), a bare short label ("codex"), or anything that uniquely suffix/
// prefix-matches a catalog id. Note: isProviderId() itself can't do this
// matching anymore — it's just a structural (non-empty string) check now
// that the catalog is dynamic, so every candidate has to be checked against
// the actual catalog here instead.
function resolveProvider(raw: string, catalog: ProviderInfo[]): ProviderId | null {
  const exact = catalog.find((p) => p.id.toLowerCase() === raw);
  if (exact) return exact.id;
  const byShort = catalog.find((p) => p.shortLabel.toLowerCase() === raw);
  if (byShort) return byShort.id;
  // bare suffix: "opus" matches "claude-opus"; also matches the model half
  // of a composite id like "deepseek:deepseek-v4-flash".
  const bySuffix = catalog.filter(
    (p) => p.id.toLowerCase().endsWith(`-${raw}`) || p.id.toLowerCase().endsWith(`:${raw}`),
  );
  if (bySuffix.length === 1) return bySuffix[0].id;
  // unique prefix of the id.
  const byPrefix = catalog.filter((p) => p.id.toLowerCase().startsWith(raw));
  if (byPrefix.length === 1) return byPrefix[0].id;
  return null;
}
