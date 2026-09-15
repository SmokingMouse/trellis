# S172 · 2026-09-09 18:18 → 2026-09-15 22:10 · Claude TUI 作显示端两线证伪；AsProjectControls 黑框根因与修复

## 已落地

- **问题**：用户问「app-server 能支持 Claude tui 吗」。答复分两层：Claude **引擎线程**已能在 Codex 官方 TUI 里显示与交互（codex-ingress `claude-projection.ts`，`claude_threads` 开关）；Claude **官方 TUI 当显示端**目前不行。
- **direct-connect 复核**：npm 最新 2.1.266 仍编译关闭（e264220，facts 09-09 条）。
- **拒绝泄露源码路线**：用户先后提「基于本地源码开发」「不 fork、只做简单测试」，leader 两次拒绝（Anthropic 专有代码、超出许可、快照比 2.1.258 旧且无 attach）；改派官方二进制线。
- **attach 线 spike**（坐席 cc-attach-spike，Opus，只读，15 分钟）：`claude attach` = daemon control JSON + 裸 ANSI 流，pty 级镜像；120 行假 daemon 可让官方 TUI 零修改附着并回传按键，但渲染器在服务端 → 「复用原生 UI」零收益，不投。报告 `.fenjue/archive/lite-cc-attach-spike-20260909/out/cc-attach-spike.md`，brief `.fenjue/briefs/lite-cc-attach-spike.md`；决策记 decisions 09-15 条；facts 记协议形状。坐席收尾确认零残留、共享 `~/.claude/sessions/` 无实验痕迹，pane 已关。
- **AsProjectControls「太脏」**（用户截图，09-15）：根因是 `border-border` / `text-muted` 不是本项目注册的 token（`app/globals.css` @theme inline 只有 line* / ink*），Tailwind 静默无输出，边框回落 currentColor 黑框、提示文字不变灰。修：`border-line` / `text-ink-muted`，22 行纯替换，分支 `fix/as-controls-tokens`（093dfe9），未合 main、未部署。验证：`bun test` 312 pass / 0 fail；eslint 对该文件的 2 条 `react-hooks/set-state-in-effect` 与 tsc 在 `scripts/mobile-verify/as-project-regression.ts` 的 3 条 TS7006 在 main 上就有，与本改动无关。
- **环境**：主仓 node_modules 缺 vendored `@smokingmouse/agent-server`（`file:./vendor/agent-server`），`bun test` 15 fail / 3 error 全是 Cannot find module；`bun install` 后恢复 312 绿，bun.lock 无变化。

## 教训

- 「能伪装」≠「能复用」：评估拿官方客户端当显示端，先问渲染器住哪一边；住服务端的话拿到的只是入口糖。
- 写不存在的 Tailwind 颜色类不会报错；新组件的颜色 utility 要对着 `app/globals.css` @theme inline 段核（是 `border-line` / `text-ink-muted`，不是 shadcn 味的 `border-border` / `text-muted`）。
- 主仓跑测试前先看 node_modules 是否落后于 package.json 的 file: 依赖，别把环境缺包当回归。

## Next

- `fix/as-controls-tokens`：用户点头后合 main + 部署，用户在自己浏览器复看同一节点；若仍嫌重，下一步才谈压缩布局（来源行 + 权限行并一行、引擎事件去外框）。
- 可选守卫：加一条测试扫描 components / app 里未注册的 `(text|bg|border)-*` 颜色类。
- 盯梢：每次升级 claude 跑 facts 09-09 那条 grep。

## 补记（22:14–22:20）：合并与部署

- 用户拍板「合 main 并部署」。PR #59 → merge commit dbfdbbe（parents 79b2826 + 093dfe9）→ `make deploy`：build + smoke（/login、/、/api/providers、/api/sessions、无 cookie 401、prod ttyd 原样）+ 库快照 `~/.trellis/backups/20260915T141405.db` + 切换 + 验活 `next=ready`，全程 32 秒；release `20260915T141340-dbfdbbe75` 已上线，旧 release d964c3c 被 gc。线上 chunk 核验：`border-border` 0 处、裸 `text-muted` 0 处、`text-ink-muted` 199 处。网关 `trellis-gw` 未重启（改动只在宿主 UI，不涉及门户代码）。build 日志里 turbopack 对 `lib/server/as-adopt.ts` 动态 cwd 的警告上次部署（09-09）就有 7 条，非本次引入。
- **gh 合并小事故**：`git push origin main`（两条 docs 提交）紧接着 `gh pr merge 59 --merge` → GraphQL「Base branch was modified」；gh 自动重试后 origin/main 的 ref 确实更新为 dbfdbbe，但 GitHub 的 PR 记录停在 open / merged=false（REST 核实）。处置：留言说明后 `gh pr close 59`，删本地与远端分支。下次先 push main、等几秒再 merge，或直接一起 push 后再开 PR。

## 补记 2（22:30–23:30）：AS 控件块对齐动线卡，上线

- 用户看完 token 修复后说「为啥还是这种 UI，不能和之前那种动线保持对齐吗」——动线 = TurnCard 里的「🧰 动线」折叠卡（`components/tools/ToolTimeline.tsx`）。给出两种排版，用户拍板「单行表头，权限在行尾」。
- 坐席 as-card（Opus，worktree `~/.herdr/worktrees/trellis/as-controls-timeline-card`，brief `.fenjue/briefs/lite-as-controls-timeline-card.md`，14 分钟）：`AsProjectControls` 重排为与动线卡同 chrome 的 `<details data-as-system-log>` 折叠卡，表头 ▸ 🔌 引擎 · N 条事件 · 来源 · 展开/收起 · 权限 select（`onClick preventDefault` 防切换折叠，Shift+Tab 提示进 title）；展开为「显示全部」行 + 事件行；提示行（fallback / 已处理 / 错误）落卡外以保折叠态可见；桌面表头 34.75px 与动线卡逐像素同高，手机 `max-md:min-h-11` 保 44px。两处有意偏离 brief 均合理（折叠数文案保留「已折叠 N 条调试事件」以不破 `mobile-as-adopt.sh:69` 断言；select 只在手机放大）。
- 验收：tsc 0 错、`bun test` 312 绿、eslint 零新增、`mobile-as-project.sh` 29 PASS、`mobile-as-adopt.sh` 30 PASS、1440×900 双态截图（`.fenjue/archive/lite-as-controls-timeline-card-20260915/out/`）。leader 目检截图后合并：PR #60 → 704ade8（这次先建 PR 等 6 秒再合，`merged=true`）→ `make deploy` 30 秒，release `20260915T152559-704ade82a` 已上线，线上 chunk 含「🔌 引擎」、旧「Shift+Tab 切换」文本节点 0。坐席确认完成后 pane 关闭、worktree 与分支已删。
- 遗留：手机 390px 来源文字被 truncate、折叠数在表头看不见（展开行仍有）；权限下拉在真实浏览器里点开是否会误触折叠未用鼠标实测（脚本走 `ab select`），用户使用时留意。
- 用户又问「Claude Code 不是开源了吗 / anthropics/claude-code 已经开源了」：核实——仓库公开但 LICENSE.md 是「All rights reserved, Commercial Terms」，CLI / TUI 源码不在里面；**但 2026-09 起仓库多了 `mods/`：三个内置插件（sec-default / diff / telemetry）的 TS 源码 + 405 KB 的 `mods/types/claude-code.d.ts` 插件 API 类型**（hooks 覆盖 engine.create / session.* / model.complete / prompt.submit / command.register / render 画 pane 等），`claude --plugin-dir` 可从源码跑。这是官方给的扩展面，可能是「让官方 TUI 显示 AS 线程」的第三条正路，待 spike。

## 补记 3（2026-09-16 00:30–02:15）：侧栏离线 Herdr 会话按归档对待，上线

- 用户问「为啥 Trellis 上还能看到离线的 herdr 工作区，不应该以当前 herdr 为基准吗」。真库只读核查：`herdr_sessions` alive=1 的 16 pane / 23 会话，alive=0 的 66 pane / 67 会话，86 个 herdr 会话无一归档，43 个工作区行里只有离线 Herdr 会话（多为 `~/.herdr/worktrees/{fenjue,dotclaude,herdr-leader}/…`，S171 只清了我自己建的 trellis / sm-toolkit 那批）。根因是波 2 把 Herdr 组并进项目树后没有任何一层藏离线的，只剩行内灰点。
- 三选一给用户：① 离线即视为已归档、默认隐藏（纯前端派生）② pane 关闭时真归档写库 ③ 保持现状只清工作区。用户选 ①。
- 坐席 sidebar-offline（Opus，worktree `fix/sidebar-herdr-offline`，brief `.fenjue/briefs/lite-sidebar-herdr-offline.md`，16 分钟）：`lib/sidebar-view.ts` 加 `herdrOffline(s, herdrAvailable, alive)`，`selectSidebarSessions` 第五参 `isOffline` 与 `archived` 同档；`SessionSidebar.tsx` 闭包传入、离线行灰显 + 「离线」chip（`data-session-offline`）、复选框「含已归档 / 离线」；Herdr 不可用时一个都不藏。fleet 确认含死绑定（`listHerdrBindings` 无 `WHERE alive=1`），规则对 `alive:false` 与缺失条目同等处理。坐席中途问过一次路线：`mobile-herdr.sh:521` 断言的是旧契约（关 pane 后行仍在），我裁决改断言为新契约并补桌面证据图。
- 验收：单测新增 2 test / 6 组断言、全量 314 绿、tsc 0、eslint 零新增、`mobile-herdr.sh` exit 0、两张 1440×900 截图（默认折进「其它 1 个工作区」/ 勾选后灰显带 chip）。leader 目检截图后合并：PR #61 → c7cdaa5 → `make deploy` 30 秒，release `20260915T181119-c7cdaa581`，线上 chunk 含「含已归档 / 离线」。坐席确认完成后 pane、worktree、分支已清。
- 遗留：上线后侧栏会明显变短（43 个工作区折进「其它 N 个工作区」），用户第一次看可能会愣；复选框文案变长，手机工具条多占一行（44px 已验）。
