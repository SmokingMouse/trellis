目标：验证「Claude Code 原生 TUI 作显示端、agent-server 作内核」是否可行（用户诉求：尽量复用原生交互体验，不自己造 TUI）。你是 Opus 调研坐席，只读契约：不改任何仓库文件，原型与临时文件只放 mktemp。

输入：
- 泄露源码 `/Users/smokingmouse/python/ai/claude-code`：`src/server/`（direct connect：ServerConfig / SessionIndex，`createDirectConnectSession.ts` 的 `POST ${serverUrl}/sessions`，REPL 的 `directConnectConfig`）、`src/remote/`（RemoteSessionManager：WS 收消息 + HTTP POST 发消息 + 权限经 WS 回传；`sdkMessageAdapter.ts` 的 SDK→内部消息转换）、`src/bridge/`（replBridge、bridgePermissionCallbacks）。解构报告 §8：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cc-tui-design-c117/out/cc-tui-design.md`。
- 本机公开构建：`claude`（`~/.local/bin/claude` 是包装脚本，找到实际 cli.js 或二进制；`claude --version`）。
- 我们的内核：`/Users/smokingmouse/.herdr/worktrees/sm-toolkit/feat-agent-server/packages/agent-server/src/protocol/`（Thread / Item / turn / pendingRequests / lease）。

问题：
1. 公开构建里这些客户端模式是否存在且可达：在 cli.js / 二进制里 grep directConnect、remote-control、RemoteSessionManager、assistant、sessions 端点等标识与对应 CLI flag / 环境变量（`claude --help` 与隐藏 flag）；哪些被 feature flag 编译掉，哪些需要 OAuth / claude.ai 账号态。
2. 协议形状：服务端需实现的端点与消息（会话创建、SDK 格式消息流、权限 control_request / control_response 与取消、中断、会话列表与恢复、认证握手）；与 AS 的 Thread / Item / turn / pending 的映射表；信息损耗点（如 tool progress）。
3. 最小原型：在 mktemp 里用 Bun 起一个假服务端，让公开 `claude` 二进制以该模式连上、显示一条 assistant 消息、并回传一次权限请求；记录成功 / 失败与卡点（认证、TLS、host 校验、版本握手、SDK 消息校验）。
4. 结论：可行 / 有条件可行 / 不可行；AS 侧适配层估工（坐席单数）；风险（未文档化协议随版本漂移、只覆盖 Claude 线程、与 Codex 线程的关系）；与 OpenTUI 路线是并行还是替代。

产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/cc-native-tui-spike.md`（中文，带 file:line 与命令输出摘要；原型代码放 out/proto/）。私有源码只做参考，禁止整段抄。
