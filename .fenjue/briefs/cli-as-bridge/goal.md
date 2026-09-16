目标：给 `llm`（apps/cli）加一条可选的 agent-server 路线——`llm <model> --as` 先经 as/1 在常驻 daemon 上建一条 backend=claude 的线程，再 exec 官方 Codex TUI `resume <nativeId>` 接上去；默认行为一字不改（仍是本地 spawn claude）。这是调研单 fj-cli-as-bridge-0b2e 推荐的方案 A 最小切片。报告在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cli-as-bridge-0b2e/out/cli-as-bridge.md（§2.0 共享底座、§2.A 形状与改动点、§3.3 分步、§4 真机帧），先通读它：协议细节、错误码、权限映射、参照实现（fj.js 的 codex-tui runner）位置都在里面，不要重新调研。

## 要求

1. 新文件 `apps/cli/src/as-client.ts`：unix socket + NDJSON 的 as/1 客户端，覆盖 initialize/initialized、server/health、server/config/read、thread/start、thread/read、thread/close；每个请求带超时（默认 5 s，thread/start 15 s）；错误码翻译表至少含 -32005（cwd 不在 allowed_roots）、-32602 reason=model_denied、-32602 reason=model_required、-32004；token 读 `~/.agent-server/token`。单测用 fixture socket（自己起一个假 server）跑通握手与四种错误翻译，不连真 daemon。
2. 新文件 `apps/cli/src/as-launch.ts`：读 endpoint 文件（默认 `~/.sm-toolkit/agent-server.sock.endpoint.json`，环境变量 `SM_AS_ENDPOINT_JSON` 可覆盖路径；每次都重读，不缓存端口）；codex 二进制能力探测（`codex --help` 含 `--remote-auth-token-env`，bin 路径可由 `SM_AS_CODEX_BIN` 覆盖，默认按 PATH 找）；permission → `--sandbox` / `--ask-for-approval` 映射照报告 §2.A 的表；argv 拼装（`codex --remote <codexIngressUrl> --remote-auth-token-env AS_NATIVE_TOKEN --sandbox … --ask-for-approval … resume <nativeId>`，nativeId = thread.id 去掉 `th_` 前缀）。单测：四种 permission 各出一条期望 argv。
3. `apps/cli/src/main.ts` 接线（只动 execClaude 尾部与 parseArgs/printHelp）：
   - 新 flag `--as` / `--local` / `--permission <readonly|default|auto-edit|full>`（默认 full，对齐今天的 `--dangerously-skip-permissions`）/ `--print-launch`；环境变量 `LLM_ROUTE=as|local` 设默认路线，flag 优先。
   - 路线判定：`--as`（或 LLM_ROUTE=as）→ 依次 endpoint 文件可读 → server/health → server/config/read 校验 cwd 在 allowed_roots → thread/start。环境类失败（endpoint 文件缺、连不上、health 不 ok、cwd 不在 allowed_roots）一律静默回落本地 spawn claude，stderr 打一行原因，格式 `llm: agent-server 不可用，回落本地：<原因>`，cwd 那种原因里必须含字面 `allowed_roots`。策略类拒绝（model_denied / model_required）不回落：stderr 打人话（含 pattern 与「改用别的模型，或加 --local」提示，含字面 `denied`）并以非零退出——用户明确要上 daemon 却被策略拒了，不能悄悄换路线。
   - AS 路线成功时把被忽略的本地 launch 偏好打到 stderr 一行（顶层 claude.args 与 claude.env 的 key 名，不打值）。
   - `--print-launch`：走完全部判定与（AS 路线下的）真实 thread/start 后不 exec，向 stdout 打一行 JSON：`{"route":"as"|"local","reason":"<回落原因或 ok>","argv":[...],"threadId":"th_…"|null,"nativeId":"…"|null,"cwd":"…"}`，然后 AS 路线下把刚建的线程 thread/close 掉再退出 0——它是 dry-run，不能在 daemon 上留线程。
   - 别名 / MRU / picker / `-p` / `bench` 一律不动；`packages/llm` 与 `packages/agent-server` 不动。
4. `apps/cli/README.md` 加一节「跑在 agent-server 上」：怎么开（`--as` / `LLM_ROUTE`）、三条坑（cwd 必须在 allowed_roots、fable 被 denied_models 拒、改 endpoints.yaml 后要重启 daemon 才生效）、显示端是 Codex TUI 不是 Claude Code TUI。
5. 真机证据 `out/as-proof.md`：在 HOME 下某个目录用 pty（`script -q` / tmux / expect 任选）真的跑一次 `llm sonnet --as`，在 TUI 里发「只回复 ok，不要用工具」，收到回答后退出 TUI；证据 = 该线程 thread/read 的 item 摘要（含 agentMessage "ok"）+ TUI 输出片段 + 退出后 thread/list 里线程仍在，然后 thread/close 清掉。再跑一遍硬验收脚本 `bash /Users/smokingmouse/python/learning/trellis/.fenjue/briefs/cli-as-bridge/verify.sh <ok|down|tmp|fable>` 四种情形并贴 stdout+stderr（这四条就是 settle 的机械验收，过不了不放行）。pty 驱动确实做不到就退而求其次：用 `--print-launch` 拿到 argv 后自己在 pty 里 exec 同一 argv，证据同上，写清为什么。
6. `bun run typecheck`（仓库根）与 `apps/cli` 下 `bun test` 全绿；提交到当前分支 `feat/cli-as-bridge`，工作树干净。不 push、不 PR、不发版、不重启常驻 daemon、不改 daemon 配置、不碰常驻 daemon 上不是你建的线程；你建的线程全部 thread/close。
7. `out/result.md`：改动清单（含测试文件）、每条命令与 exit、路线判定的决策表（哪些回落哪些报错）、与报告 §3.3 逐步对照、未覆盖项（若有）与原因。

## 环境提示

- 常驻 daemon 是 launchd `com.smokingmouse.agent-server`，endpoint 文件 `~/.sm-toolkit/agent-server.sock.endpoint.json`，token `~/.agent-server/token`；allowed_roots 默认只有 HOME；denied_models 默认拒 fable / claude-fable*。
- codex 二进制：/Users/smokingmouse/.nvm/versions/node/v24.14.1/bin/codex（0.153.4，支持 --remote-auth-token-env）。
- 网关的 codex 号池今天下午 503，与你无关：你只起 Claude 线程（sonnet），不要用 gpt 模型做证据。
- worktree 已 bun install 过；`llm` 的 endpoints.yaml 本机命中 `~/.claude/global/endpoints.yaml`。
