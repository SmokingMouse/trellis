目标：agent-tui 改造方案的阶段 0「合规闸与依赖锁」（方案 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-adoption-plan-7755/out/tui-adoption-plan.md` 的「### 阶段 0」一节与 §6.3 合规节，先读这两节；§2.6 说明绑定层定档 React）。分支 feat/tui-phase0（基于 feat/agent-server），worktree 无 node_modules，先 `bun install`。
交付：
① `scripts/check-cc-taboo.sh <rev-range>`：对 diff 跑禁用标识符清单（§6.3 给的 Claude Code 与 opencode 两套）+ 禁止出现的快照路径 grep（`/Users/smokingmouse/python/ai/claude-code`、任何 opencode 本地 clone 路径），命中即非零退出并打印命中行；挂进 CI（现有 workflow 或 package.json 脚本）与 PR 模板。
② 锁定 `@opentui/core@0.5.11`、`@opentui/react@0.5.11`、react 19.2.4 进 apps/agent-tui 的依赖并写入 lockfile；实测确认 `@opentui/keymap` 的真实 npm 包名与版本（`bun add` 或 `npm view`），不存在独立发布就在 out/result.md 写明并按方案退化口径处理；`bun install` 后在 macOS arm64 下 `bun -e "import('@opentui/core')"` 零 Zig 工具链可运行。
③ `third_party/opentui/` 随包保留 LICENSE、LICENSE.ghostty、LICENSE.wuffs、LICENSE.stb、LICENSE.lcms2、LICENSE.libwebp、AUTHORS.libwebp、PATENTS.libwebp（从 node_modules 的 @opentui/core 包或上游仓取，来源写进 README）。
④ 根 tsconfig.json 加 jsx 配置（react-jsx），typecheck 全绿。
约束：不改任何现有运行时代码；不引入 Solid。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`（keymap 包名/版本结论、许可文件来源、脚本用法）。提交到本分支。
