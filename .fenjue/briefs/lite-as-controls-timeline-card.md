# AS 控件块对齐「动线」卡（单行表头，权限在行尾）

目标：把 `components/AsProjectControls.tsx` 重排成与 `components/tools/ToolTimeline.tsx` 同一套卡片语言的折叠卡：一行表头 + 展开后的分隔线列表。用户 2026-09-15 已拍板排版（见 §设计）。行为、数据流、SSE、权限 POST、localStorage / sessionStorage 记忆全部不变；只改 JSX 结构与样式。

工作目录：本 worktree（分支 `fix/as-controls-timeline-card`，已 `bun install`）。产物目录（绝对路径，主仓内、git 忽略）：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/lite-as-controls-timeline-card-20260915/out/`。

## 参考（先读）

- 动线卡：`components/tools/ToolTimeline.tsx:62-121`——卡 chrome、表头、chevron、右侧「展开 / 收起」、展开列表 `border-t border-line divide-y divide-line/70`。这就是要对齐的目标。
- 现组件：`components/AsProjectControls.tsx`（S165 引擎事件人话化之后的版本；本周 093dfe9 只换了 token）。
- 主题 token：`app/globals.css` 的 `@theme inline` 段（只有 line* / ink* / surface* / accent* / warn* / danger* 等）。**禁止** `border-border` / `text-muted` 这类不存在的类——Tailwind 静默无输出。
- 手机验收脚本（DOM 钩子必须保留）：`scripts/mobile-verify/mobile-as-project.sh`、`scripts/mobile-verify/mobile-as-adopt.sh`。

## 设计（用户拍板）

折叠（默认）：
```
│ ▸ 🔌 引擎  0 条事件  claude · Agent 会话 · 6 条调试已折叠             权限 [绕过审批 ▾] │
```
展开：
```
│ ▾ 🔌 引擎  2 条事件  claude · Agent 会话 · 6 条调试已折叠             权限 [绕过审批 ▾] │
├──────────────────────────────────────────────────────────────────────┤
│ ☐ 显示全部（含 6 条调试）                                              │
│ 12 秒前  thread/permission/changed  权限改为绕过审批                 ▸ │
│ 3 分钟前 turn/started               轮次开始                         ▸ │
```

### DOM 约束（脚本依赖，逐条对照）

- 根 `div[data-as-project=<nodeId>]` 保留。
- 卡本体 = `<details data-as-system-log>`（默认不 open）；`<summary>` 是它的**直接子元素**、就是整行表头（脚本用 `[data-as-system-log] > summary` 点击并读 `.open`）。
- 权限 `<select data-as-permission>`（外部会话为非 select 的 `[data-as-permission]` 徽标 + 淡色「只读」）放在 summary 行尾（`ml-auto`）；给 select 加 `onClick={e => e.preventDefault()}`，避免点选择器时切换折叠；Shift+Tab 切换逻辑保留，「Shift+Tab 切换」文案改进 select 的 `title`，不再占位。
- 来源 `data-as-source` 保留，作为表头里的淡色文字：`{backend}{external ? " · 外部会话" : ""} · {title ?? "Agent 会话"}{closed ? " · 已结束" : ""}`。
- 展开区第一行 `<label>` 内 `input[data-as-show-all]`，文案「显示全部（含 N 条调试）」（N=0 时「显示全部」）；事件行 `<details data-as-engine-event>` + `<summary>`（相对时间 / method 等宽小字 / 摘要）+ `<pre>` 原始 JSON；无可见事件时一行淡色「暂无需要关注的引擎事件」/「等待引擎事件」。列表区保留 `max-h-64 overflow-y-auto`。
- `data-as-resolved`（「已由 X 处理」）、`data-as-fallback`（role=status）、error（role=alert）在**折叠态也必须可见**（脚本用 innerText 断言）：渲染在卡内 summary 之外做不到，所以放在卡**外**、紧贴卡下方的独立细行（`text-ui`），不能塞进 details 内容区。
- 手机 44px 硬断言：`[data-as-project] select` 与 `[data-as-project] summary` 的 boundingRect 宽高 ≥ 44。用 `max-md:min-h-11` 只在手机放大；桌面与动线卡同高（`py-2 text-ui`）。select 保持 `min-h-11 min-w-11`。
- 手机 390px 宽不横向溢出：来源文字 `min-w-0 truncate`，select `shrink-0` 不换行；根容器 `[overflow-wrap:anywhere]` 保留。

### 样式

- 卡：`mb-3 border border-line rounded-card overflow-hidden bg-surface-muted/60`（与动线卡逐字相同）。
- 表头 summary：`px-3 py-2 flex items-center gap-2 text-ui cursor-pointer hover:bg-surface-muted transition-colors list-none [&::-webkit-details-marker]:hidden`；自绘 chevron `▸`（`text-ink-faint`，open 时 `rotate(90deg)`，用 `group-open:` 或 `[details[open]>&]` 变体都行）。
- 标签 `font-medium text-ink`「🔌 引擎」（图标可换更贴切的，但结构不变）；计数 `text-ink-muted tabular-nums`「N 条事件」；来源 + 折叠数 `text-ink-faint truncate min-w-0`；「展开 / 收起」`text-nano text-ink-faint hidden sm:inline shrink-0`，放在 select 之前。
- 展开列表 `border-t border-line divide-y divide-line/70`，每行 `px-3 py-2 text-ui`。

## 约束

- 只改 `components/AsProjectControls.tsx`（必要时同文件加纯展示子组件）；不动 ToolTimeline、store、API、脚本断言。
- 在本 worktree 分支上直接 commit（`git add <file>` 精确暂存）；**不 push、不合并、不部署**，leader 收尾。
- 不连生产 daemon、不写生产库（`~/.trellis/data.db`）；验证只用脚本自带的隔离方式。
- 临时文件放 mktemp；截图与日志放产物目录。

## 验收命令（自己跑通再交，日志留产物目录）

1. `bunx tsc --noEmit`：`scripts/mobile-verify/as-project-regression.ts` 的 3 条 TS7006 是 main 既有，可忽略，不得新增。
2. `bun test`：312 pass / 0 fail。
3. `bunx eslint components/AsProjectControls.tsx`：不得新增问题（main 既有 2 条 `react-hooks/set-state-in-effect`，允许顺手修，但不是本单目标）。
4. 手机脚本（先读脚本头部确认它们自己的隔离前缀 / 端口 / fixture 约定，以脚本为准）：`env -i HOME=$HOME PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=$HOME/.trellis/data.db bash scripts/mobile-verify/mobile-as-project.sh` exit 0；同前缀 `mobile-as-adopt.sh` exit 0。
5. 桌面截图：用脚本同款隔离实例（或同法起一个），1440×900，「折叠态」「展开态」各一张，落 `out/shots/`；表头必须与紧邻其上的动线卡同高同 chrome，肉眼核过再交。

## 汇报

最终结论用中文总结：改了什么、验收各项结果（含截图路径）、遗留。完成后在终端最后一行打印：`DONE: <一句话结果>`
