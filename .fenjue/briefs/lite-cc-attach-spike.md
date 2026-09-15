# 只读 spike：官方 `claude attach` 能否让 Claude Code TUI 当 agent-server 的显示端

目标：用官方 Claude Code 二进制验证——`claude attach <id>` 连后台会话走的是什么本地协议；一个第三方服务端（我们的 agent-server）能否伪装成「后台会话」让官方 TUI **零修改**附着上来当显示端。交付一份 spike 报告（先结论后证据）。

本机二进制：`claude --version` = 2.1.258。`~/.local/bin/claude` 是注入 HERDR_AGENT 的 shell shim，**实验一律直接用真身** `~/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`，免得 pty 里起的实验会话被 Herdr 识别成坐席。

## 背景（先读）

- `.fenjue/archive/fj-cc-native-tui-spike-0e0a/out/cc-native-tui-spike.md`：昨天证伪了 direct-connect（`claude cc://host:port/token`）入口——公开构建里被 `bun:bundle` 编译期宏裁掉；但接收侧类 `DirectConnectSessionManager`（WS stream-json 客户端，`Unsupported control request subtype` 13 处）在 2.1.258 与 2.1.266 里都还在。**本 spike 的假设：`claude attach` 就是这个接收类的公开入口。**
- 同目录 `out/proto/fake-server.ts`（Bun 假服务端：`POST /sessions` + WS）与 `out/proto/drive-claude.py`（pty 驱动 TUI）可直接复用 / 改造。
- 本机观察：每个交互会话登记在 `~/.claude/sessions/<pid>.json`（字段 pid / sessionId / cwd / startedAt / version / peerProtocol=1 / peerFeatures / kind=interactive / entrypoint=cli / messagingSocketPath=`/tmp/cc-socks/<pid>.sock` / name / status），旁边有 `<pid>.<hash>.key`。
- `claude attach --help`：「Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops back to your shell. The session keeps running either way.」另有 `claude stop <id>`、`claude respawn <id>|--all`。CHANGELOG 里后台会话有 retire→wake 语义。

## 要回答的问题（每条带证据：命令 + 输出摘录）

1. **`/bg` 后发生了什么**：登记表新增 / 变化的字段（kind / status / entrypoint …）、新进程（父子关系）、新 socket / 监听端口（`lsof -U` / `lsof -i -P`）、`~/.claude`（或隔离的 CONFIG_DIR）下新文件。后台进程是原进程还是新起的？
2. **`claude attach <id>` 的 id 解析**：接受 pid / sessionId / name 哪种；从哪个文件找目标；连接哪个端点（messagingSocketPath？另一个 socket？TCP？）。
3. **协议形状**：把登记表指向你的假服务端（或用 socat 中间人夹在真 socket 前面）抓握手与帧。判定属于哪一种：
   - (a) direct-connect 方言：HTTP `POST /sessions` + WebSocket 换行分隔 JSON，帧 `type` = user / control_request / control_response / assistant / result …
   - (b) peer messaging 协议（peerProtocol 1，notify_idle 等）
   - (c) pty 级镜像 / 其它
   若是 (a)：与昨天报告 §2 逐条对照差异（URL / 鉴权 / 请求体 / 帧类型），并让假服务端推一条 `assistant` 文本 + 一条 `can_use_tool` 审批，看 TUI 是否渲染、答复是否回到服务端（截屏 / 日志为证）。
4. **结论**：agent-server 能否伪装后台会话作为官方 TUI 的显示端。能 → AS 侧适配估工（对照昨天 §5 的 2 坐席日）+ 新增风险（版本漂移、登记表格式、key 文件、Ctrl+Z 语义、retire/wake）；不能 → 判死理由与可复跑的判据。

## 约束（硬）

- 只用官方二进制的**公开表面**（`--help`、公开文档、登记文件）+ **你自己起的进程 / socket 上观察到的流量**。**禁止读取或使用 `~/python/ai/claude-code`（泄露源码）**；禁止反编译、patch 二进制。
- 不动别人的会话：`~/.claude/sessions/` 现有条目一个都不许改 / 删；只操作你自己起的会话（起完立刻记 pid）。**禁止 `claude respawn --all`**；`claude stop` 只对自己起的 id。优先用 `CLAUDE_CONFIG_DIR=$(mktemp -d)` 隔离登记表；若隔离后 attach 找不到目标或登录态丢失，再退回共享登记表，但**只加不改**。
- 不改任何仓库文件（报告目录除外）；临时文件只放 mktemp；结束时清理自己起的进程（列出 pid 核对后再 kill）。
- 本机 curl 访问本地地址加 `--noproxy '*'`。
- 报告写到 `.fenjue/archive/lite-cc-attach-spike-20260909/out/cc-attach-spike.md`（结构对齐昨天那份：结论 → 各问证据 → 估工 / 风险 → 复现命令），原型脚本放同目录 `out/proto/`。**不要 git commit**，由 leader 收尾。

## 验收命令（自己跑通再交）

- 起假服务端 → 驱动 `claude attach` → `grep -c 'POST /sessions\|"type":"user"' server.log` 非 0 = 判定 (a) 成立。为 0 时，报告必须给出抓到的真实帧样本（判定 b / c）或判死证据。
- 报告「复现命令」一节的每条命令能在干净 mktemp 目录里重跑。

## 汇报

最终结论用中文总结成果、状态、待办。完成后在终端最后一行打印：`DONE: <一句话结果>`
