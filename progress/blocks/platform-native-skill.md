# Block: platform-native-skill（worktree 分支 `worktree/calm-meadow-e229`）

> 并行 worktree 独占进度块（规则见 `~/.claude/global/rules/parallel-worktree.md`）。
> merge 回 main 后把下方内容按归属提炼进 README/sessions/facts，然后删本文件。

## Current Focus

**trellis-admin 平台原生化：caller context 注入 + 平台 pack 默认挂载 + trellisctl 自我感知——已实现，本地全绿，待 merge + deploy 后做活体验证。**

## Session Log

### Session 1（2026-08-28）

- **缘起**：用户「让 trellis-admin 成为 trellis 平台的内置技能，并像 herdr 一样具备感知整个平台的能力（树对话/树链/tab 等），能动态增加树、节点等平时依赖 UI 交互的能力」。
- **现状盘点**（动手前）：内置技能的**分发**机制已在（`builtinSkillsRoot()` + `claudeSkillRoots()` 多根解析、agent-pack PACK_FORMAT 3、repo `skills/trellis-admin/`），trellisctl 平台操作面已全（sessions/ps/node/ask/wait/respond）。真正缺的是 herdr 模式的另一半：**平台内会话的自我感知**（spawn 的 CLI 完全不知道自己是哪个会话哪个节点，grep TRELLIS_ 零命中）与**默认可用**（技能只能靠自定义 agent 显式绑定）。
- **Done（全部在本 worktree）**：
  1. **G1 caller context 注入**（对标 HERDR_ENV/HERDR_PANE_ID）：
     - `lib/llm/types.ts`：StreamRequest + `platform?: { sessionId, nodeId }`。
     - `lib/llm/sdk-adapter.ts`：`platformEnv()`，在 `modeToRunOptions` 末尾（applyAgent **之后**，agent 层铁律是不碰上下文）合并进 RunOptions.env：`TRELLIS_ENV=1` / `TRELLIS_SESSION_ID` / `TRELLIS_NODE_ID` / `TRELLIS_URL`（仅 TRELLIS_PORT 在场时——裸 `next dev` 无大门，注错 URL 比不注更糟）。纯 chat 已有的 `CLAUDE_CODE_EFFORT_LEVEL` 合并保留。
     - `app/api/chat/route.ts` + `lib/server/tasks.ts`：两处 `llm.stream({...})` 传 platform（交互会话与无人值守任务同权）。
     - `server.ts`：bootNext env 增 `TRELLIS_PORT: String(PORT)`（gate 口唯一授源点；Next 进程的 PORT 是内部口，绝不能拿来拼 URL）。
  2. **G3 平台 pack**（内置技能默认可用，不用建 agent）：
     - 新 `lib/server/platform-pack.ts`：把 `builtinSkillsRoot()` 下全部技能物化成一个 claude plugin dir（`~/.trellis/platform-pack/<hash>/`，plugin 名 `trellis` → 技能列出为 `trellis:trellis-admin`）。内容寻址 + tmp/rename 双写安全 + TTL sweep，手法与 agent-pack 同套。`TRELLIS_BUILTIN_SKILLS=off` 冒烟闸（同 TRELLIS_LARK 风格）。
     - `lib/llm/claude.ts`：enhanced chat / project spawn 默认 `pluginDirs` 追加平台 pack（数组，与自定义 agent 的 pack 并存）。纯对话不挂（无 Skill 工具，挂了调不动）。**隔离 agent 也挂**——拍板语义：隔离隔的是「本机个人环境」（CLAUDE.md/个人 skill/MCP），不隔「所在平台的自身能力」（herdr 语义：pane 里任何 agent 天然有 herdr CLI）。
  3. **G2/G4 trellisctl 自我感知与感知面**（`skills/trellis-admin/scripts/trellisctl.ts`）：
     - `whoami`：身份来自 env 永不因 API 不可达而失败（API 增强部分手写 fetch 静默降级，刻意不走会 die 的 `api()`）；报会话标题、画布树数、自己所在树与深度。
     - `.` 目标：所有收会话/节点 id 的地方解析为当前会话/节点（`sessions get .`、`ask --session .`）。
     - 自指防护（硬拒不给 --force）：`wait`/`abort`/`retry` 自己节点（死锁/自杀/还在跑）、`ask --node` 自己（正解 `--session .` 开平行树；project 下还会双进程写同一 lineage jsonl）、`sessions rm` 自己所在会话。
     - 新读命令：`search`（FTS5 全文检索问题/回答/引用/笔记）、`workspaces`（最近工作目录）。
  4. **G5 SKILL.md**：新增「你可能就跑在 Trellis 里：先分清立场」一节（两种持有者、TRELLIS_ENV 检查、`.` 语法、三条纪律）；agents 表 skills 字段注明「enhanced/project 会话本就默认带内置技能」；Known Failure Modes 增两条（dev 裸 next dev 错连实例；纯对话看不到内置技能）。
  5. `~/.claude/skills/trellis-admin/` 用户级拷贝同步为新版（新 trellisctl 对旧服务端向后兼容已实测）。
- **验证**：
  - 新 `scripts/test-platform-context.ts` 21/21（env 三 mode 注入/合并不覆盖/URL 门控/off 闸/pack 物化结构/幂等/自指防护子进程冒烟）。
  - `bun test` 44/44；`tsc --noEmit` 0 错；`bun --bun run build` 过。
  - 对本机 prod 3088（旧服务端）只读兼容：health/sessions（老用法）、search/workspaces（新命令打旧 API）全部正常。
- **刻意不做**：codex 系的平台 pack（codex 技能机制是 environmentSkills/内联，另一套；TRELLIS_* env 注入 codex 子进程已顺带覆盖——bun 脚本不挑 CLI）；给 dev 裸 next dev 造 gate health 兜底（边缘场景，写进 Known Failure Modes）。
- **Next**：
  - ① merge 回 main，与 S121-S126 一起 `make deploy`。
  - ② **部署后活体验证**（本地验不了：起第二个实例会与 prod 共库双跑 scheduler，刻意不做）：开一个 enhanced chat 问「跑 `env | grep TRELLIS` 和 `trellisctl whoami`」确认注入与内置技能可调；再让它 `ask "..." --session .` 验证画布上真长出平行树。
  - ③ 待议：用户级 `~/.claude/skills/trellis-admin` 单源化（symlink 真仓或部署钩子同步），消灭双份漂移。
