目标：给 Trellis 的交互与 UI 做一次整体体检（只读，不改代码），产出一份带截图的审计报告和一组可供用户拍板的重设计方向，作为后续「整体设计优化」方案的输入。

## 背景

- Trellis = 树形/画布式多 agent 对话工作台：Next.js 15+ App Router，React，Tailwind v4（CSS-first，`app/globals.css` 1063 行，无 tailwind.config），70 个组件，约 2.8 万行 TSX。路由：`/`（主界面：会话侧栏 SessionSidebar、Header、画布 Canvas / 线性 LinearThreadView、Composer、各类 drawer/modal）、`/console/threads`（只读会话观察）、`/settings/{agents,bots,machine,models,prefs,shares,tasks,update,workspaces}`、`/admin`、`/login`。
- 已有材料（先读，别重复劳动）：`progress/mobile-shell.md`（手机精简壳规格与裁决）、`progress/cancel-send-ux.md`、`progress/mode-workspace-rebuild.md`、`docs/screenshots/`、历史审计 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-audit-f928/out/audit.md`（手机侧）。这次是**全面**体检：桌面 + 手机 + 设置后台 + 登录，重点桌面主界面。
- 用户原话背景：「我们能把 trellis 的交互/UI 啥的，整体来个大的设计优化吗」；此前对另一个 TUI 的抱怨是「对人来说，这个交互太难受了」。用户是唯一使用者（自用工具），偏好务实、不要过度设计。
- 隔离实例起法（不要碰生产 3088、不要连生产库本体）：在本 worktree `bun run build` 后用生产库快照跑 `next start`：`sqlite3 ~/.trellis/data.db ".backup /tmp/ui-audit/data.db"`，然后 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_DB_PATH=/tmp/ui-audit/data.db TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_AS=off PORT=3490 bun run start`（具体变量名以 `README.md`、`.env.example`、`scripts/mobile-verify/*.sh` 里的写法为准，先读它们）。登录 token 见 `~/.trellis/shared/.env.local` 的 TRELLIS_TOKEN（只用于本地 cookie，不写进报告）。本地请求加 `--noproxy '*'`。端口只用 3490/3491；结束杀掉进程并删 `/tmp/ui-audit`。
- 截图工具：`agent-browser`（`scripts/mobile-verify/*.sh` 里有用法），桌面 1440×900，手机 390×844。可以在快照实例里随便点、随便建会话，但**不要发真实模型请求**（快照里 AS 关着；如果 Composer 会起真实 claude/codex，就不要发送）。

## 交付物（全部放 out/）

1. `ui-audit.md`（中文），结构：
   - §1 路由与界面清单：每个路由一段：干什么、入口在哪、桌面/手机各一张截图（相对路径引用 out/shots/）、明显问题。
   - §2 核心动线走查（桌面 + 手机各走一遍，截关键步）：新建会话并提问 → 读回答 → 追问/分叉 → 处理审批/提问卡 → 找回旧会话（侧栏/搜索/最近链）→ 切换工作区/项目 → 查看坐席线程（/console/threads）→ 设置一个 agent / 任务。每条动线记：步数、卡点、不一致、找不到入口的功能。
   - §3 问题清单：按 P0（用不了/误操作/丢信息）、P1（明显别扭、绕路）、P2（不一致、视觉）分级，每条一句症状 + 截图 + 对应组件文件。
   - §4 一致性与体系：颜色/字号/间距/圆角/图标/按钮样式有多少套（从 globals.css 与组件 className 统计），modal/drawer/popover/toast 的交互模式是否统一，键盘与焦点，暗色主题，加载与空状态，错误呈现。
   - §5 值得保留的东西：现在做得好的交互（别在重设计里丢掉）。
   - §6 重设计方向候选 5–8 个：每个写「解决什么痛点、大概怎么改、动到哪些组件、粗略工作量（小/中/大）、风险」，并给出你推荐的组合与理由。方向要具体到界面层面（例如信息架构重排、导航模型、画布与线性视图关系、Composer、审批卡、会话列表、设置后台归并），不要空泛的"提升体验"。
2. `out/shots/` 截图；`out/inventory.json`：路由 → 组件 → 交互模式的结构化清单（给下一单出方案用）。
3. 不改任何仓库文件；不发 blocker 问审美问题，自己判断并写明依据；实在需要用户裁决的写进 §6 的「待用户拍板」小节。
