目标：回答「`apps/cli`（`llm` 命令）能不能和 agent-server 打通、值不值得、怎么打」——只读调研，产出一份能让人拍板的方案报告，并用真机验证一条关键假设。

## 背景（已核实）

- `apps/cli` = `@smokingmouse/cli` 0.5.1，`llm` 命令：交互选模型启动 Claude Code session、`-p` 直连 API 单轮问答、`bench` 测速；模型与端点来自 endpoints.yaml（`$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml`）。
- agent-server（`packages/agent-server`）：daemon 独占引擎进程，as/1 协议（unix socket，token 在 `~/.agent-server/token`）；`thread/start` 必须显式 model，`denied_models` 默认拒 `fable` / `claude-fable*`，cwd 须在 allowed_roots（默认 HOME）；权限 full / default / auto-edit / readonly。文档：`docs/agent-server/protocol.md`、`docs/agent-server/codex-tui-quickstart.md`、`packages/agent-server/README.md`。
- 显示端：官方 Codex TUI 经 codex-ingress 连 daemon（`codex --remote <ws> --remote-auth-token-env <ENV> [--model …] [resume <uuid>]`），`--model` 为 sonnet/opus/claude-* 时是 Claude 线程、否则 Codex 线程（`src/ingress/codex/router.ts` 的 `isClaudeModel`）；入口地址读 `~/.sm-toolkit/agent-server.sock.endpoint.json` 的 `codexIngressUrl`，端口每次重启会变。
- 已有一个「先经 as/1 建线程、再起官方 TUI resume」的实现可参照：herdr-leader 的 fj codex-tui runner（`~/.claude/skills/herdr-leader/references/runners/codex-tui.md`，实现在 `~/.claude/skills/herdr-leader/scripts/fj.js`，搜 `codex-tui`）。
- Trellis 侧 `TRELLIS_AS_ADOPT=on` 会自动收编 daemon 上的外部线程并在主页显示、可审批可中断；所以「llm 起的会话跑在 daemon 上」= 自动出现在 Trellis。
- 常驻 daemon 今天有一条 Trellis 原生会话用的模型是 `cpa:gemini-3.8-flash-high`（网关模型），说明 AS 的 Claude 引擎能接非官方模型名；具体怎么解析要查 `packages/agent-server/src/engines/claude.ts` 与 `packages/agent`。

## 要回答的问题

1. `llm` 今天的启动链路：`llm <model>` 到 `claude` 进程之间经过什么（endpoints.yaml 的 claude.args、env 注入、别名/MRU、provider 分派），`-p` 与 `bench` 各走什么；给文件:行。
2. 「打通」的三种候选，各自：改动点（文件级）、边界条件、估算（坐席日）、风险：
   A. `llm` 起的交互会话跑在 daemon 上：先 as/1 `thread/start`（模型、cwd、权限），再 exec 官方 Codex TUI `resume <uuid>`（fj runner 的人类版）；
   B. `llm` 只做启动器：直接 exec `codex --remote <ingress> --remote-auth-token-env … --model <x>`，让 TUI 自建线程；
   C. `llm -p` 单轮走 as/1（无 TUI），输出流到终端。
   每种必须写清：网关模型（`cpa:*` 等 endpoints.yaml 里的名字）在 AS 里怎么落到 Claude 引擎（凭证从哪来、daemon 是 launchd 起的、env 不随客户端传）、fable 被拒时给用户什么、cwd 不在 allowed_roots 时怎样、审批在官方 TUI 里怎么答、Claude 线程在 Codex TUI 里的已知限制（effort 只在启动时、多选问答投影）、daemon 没起时的降级、`llm` 现有别名/MRU/bench 是否原样保留。
3. 推荐一条路 + 最小可用切片（一句话验收判据）+ 分步。
4. 真机验证一条关键假设：用 endpoints.yaml 里的一个网关模型名（优先 `cpa:gemini-3.8-flash-high`）经 as/1 在常驻 daemon 上起一条 readonly 线程，cwd 用 `$HOME` 下一个临时目录，一轮「只回复 ok」，记录成功/失败的帧与错误码，结束后 `thread/close`。不碰 daemon 上别的线程，不改 daemon 配置。

## 产出

`out/cli-as-bridge.md`，五节对应上面 1–4 加「结论一句话」放最前；每个判断带文件:行或帧证据；不写代码改动，不改仓库任何文件。
