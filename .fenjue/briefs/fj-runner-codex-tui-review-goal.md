复核焚决 fj 的 `--runner codex-tui`（fj-fj-runner-codex-tui-383b，产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-fj-runner-codex-tui-383b/out/result.md`，坐席自报 partial，先读其未完成项逐条核实）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。仓库 = 本 worktree（焚决 feat/agent-tui-runner，fj 源码 src/，bundle skill/scripts/fj.js）。所有真机用隔离 daemon（mktemp clone sm-toolkit feat/codex-ingress → bun install && bun run build → `codex_ingress.enabled=true`、`claude_threads=true`、随机端口、独立 HOME/DB），不碰生产 daemon、不动安装副本 `~/.claude/skills/herdr-leader`。
必做：
1. 真机起位：用 bundle 里的 fj 对一个假契约（mktemp 下的 FENJUE_ROOT）走 `task launch --runner codex-tui` → Claude（显式 sonnet）与 Codex 各一次：as/1 建线程含 fjContext / model / permission / serviceTier=default；pane 里官方 `codex --remote … resume <uuid>` 出现并 resume 成功；契约经 turn/start 注入且坐席首轮开跑；`fj next` 能收到 progress；`task close` 关线程与 pane；不存在 ready-file 握手残留。
2. Herdr 状态旁挂 reporter：working / blocked / waiting / done 四态在 herdr 侧可观测（`herdr agent get`），显示端断开不中断线程；reporter 崩溃不影响坐席。
3. 配置与文档：policy `codex_bin` / `codex_ingress_url` / `codex_ingress_token_env`、`FJ_RUNNER_DEFAULT=codex-tui`；runners/codex-tui.md 与 SKILL/playbook 调用面；`bun test` 全绿；bundle 与源码一致（重新打包后 sha 相同）。
4. 反例：ingress 未开时的错误信息清晰；错 token；线程被外部关闭后 `fj next` 的判定；同一契约 `launch --force` 重派不留双份线程。
评级 P0（丢契约 / 双份线程 / 关不掉）/ P1 / P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
