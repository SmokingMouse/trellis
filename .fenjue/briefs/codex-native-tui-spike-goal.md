目标：验证「Codex 官方 TUI 作显示端、agent-server 作内核」的最小改动路径（用户方向：不自研 TUI，找现成能用的 TUI，把协议和我们的 app server 对齐，尽量不增加开发量）。你是 gpt-6-astra 调研坐席，只读契约：不改任何仓库文件，clone 与原型只放 mktemp，网络可用。

对象：`openai/codex`（Apache-2.0，Rust）。在 mktemp 里 clone 当前 main（记录 commit），重点看 `codex-rs/tui`、`codex-rs/app-server`（及 app-server-protocol）、`codex-rs/core`、`codex-rs/cli`：
1. 官方 TUI 现在怎么驱动内核：是进程内直接用 core，还是走 app-server 的 JSON-RPC 协议？有没有「连接外部 app-server / 远程会话」的 flag、env 或代码路径（哪怕未暴露）？给 file:line。
2. app-server 协议面：我们 agent-server 已经作为客户端接 `codex app-server`（见 `/Users/smokingmouse/.herdr/worktrees/sm-toolkit/feat-agent-server/packages/agent-server/src/engines/codex*.ts`）。如果让 agent-server 反过来**对外暴露** app-server 协议（作为代理：TUI ↔ AS ↔ codex app-server），TUI 需要的方法与通知集合有多大（列清单）、AS 的 Thread/Item/turn/pending 能否一一对应、哪些需要透传、哪些是我们加的语义（租约、审批经纪人、只读门）会与 TUI 的期望冲突。
3. 最小改动路径三选一并估工（坐席单数）：(a) TUI 已能连外部 app-server → 只需 AS 暴露协议；(b) TUI 进程内用 core → 最小 patch 让 tui 走 app-server 传输（stdio 或 socket），维护成本（跟上游 rebase）；(c) 用 `codex app-server` 原生 + 我们只做 daemon 侧接管（TUI 不动，AS 作为 app-server 的外挂观察/审批）。
4. 与 Claude 侧对照：Claude Code 公开二进制有 `claude cc://host:port/...` 直连模式（另一 spike 在做）；结论里写清两条线能否共用同一层「AS 对外协议适配」。

产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/codex-native-tui-spike.md`（中文，file:line、命令输出摘要、方法清单表）。
