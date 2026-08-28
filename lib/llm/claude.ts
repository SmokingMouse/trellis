// trellis Claude provider —— 薄 adapter,委托给 @smokingmouse/agent(~/sdk)的 ClaudeBackend。
// prompt 构造(buildPrompt)+ mode→RunOptions 映射留在 trellis;CLI spawn / stream-json
// 解析 / 真流式 delta / vision / tool 配对 / endpoints.yaml 模型解析全在 SDK。
// 详见 lib/llm/sdk-adapter.ts。
import type { LLMProvider, Mode, StreamEvent, StreamRequest } from "./types";
import { buildPrompt } from "./prompt";
import { ClaudeBackend } from "@smokingmouse/agent";
import { platformPackDir } from "@/lib/server/platform-pack";
import {
  modeToRunOptions,
  toStreamEvent,
  buildProjectPrompt,
  ensureChatScratch,
} from "./sdk-adapter";

// 裸 tier 别名("opus"/"sonnet"/"haiku")、trellis 的 legacy ProviderId
// ("claude-opus" 等)、endpoints.yaml 的模型名/"<provider>:<model>" 限定 id 都合法
// —— ClaudeBackend 内部按顺序尝试这几种解析方式,这里不再收窄成字面量联合。
export type ClaudeModel = string;

export function makeClaudeProvider(
  opts: { model?: ClaudeModel; mode?: Mode } = {},
): LLMProvider {
  const mode: Mode = opts.mode ?? "chat";
  const backend = new ClaudeBackend();
  return {
    async *stream(req: StreamRequest): AsyncGenerator<StreamEvent> {
      // project always resumes a CLI-maintained session; chat B-fork does too
      // (req.forkSession) — both send only the current question, history lives
      // in the resumed/forked session as cache-hit message blocks. Folded-string
      // buildPrompt is the fallback: chat with B-fork off (window mode回退).
      const prompt =
        mode === "project" || (mode === "chat" && req.forkSession)
          ? buildProjectPrompt(req.question, req.parentAnchor)
          : buildPrompt(req.history, req.question, req.parentAnchor);
      // chat (enhanced AND pure B-fork) spawns in CHAT_SCRATCH, so ensure it.
      if (mode === "chat") ensureChatScratch();
      const runOpts = { ...modeToRunOptions(mode, opts.model ?? "sonnet", req), signal: req.signal };
      // 平台 pack：凡有工具能力的 spawn（enhanced chat / project）默认带内置
      // 技能（trellis:trellis-admin 等）—— 平台内的 agent 天然会操作平台，
      // 对标「Herdr pane 里的 agent 天然有 herdr CLI」。纯对话没有 Skill 工具，
      // 挂了也调不动，不挂。数组追加：与自定义 agent 的 pack 并存。隔离
      // agent（settingSources:false）也挂 —— 隔的是「本机个人环境」（CLAUDE.md
      // / 个人 skill / MCP），不是「所在平台的自身能力」。
      if (mode === "project" || (mode === "chat" && req.chatEnhanced)) {
        const pack = platformPackDir();
        if (pack) runOpts.pluginDirs = [...(runOpts.pluginDirs ?? []), pack];
      }
      for await (const e of backend.run(prompt, runOpts)) {
        const se = toStreamEvent(e);
        if (se) yield se;
      }
    },
  };
}
