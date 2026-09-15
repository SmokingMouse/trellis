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
