你是 Opus 方案坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/tui-ingress-design.md`（progress 风格 spec，给 leader 拆单用，每个判断带 file:line）。用户方向（2026-09-08）：**不自研 TUI，单一显示端 = Codex 官方 TUI（Apache-2.0，`codex --remote ws://…` 零修改），agent-server 对外暴露 app-server 协议把事件渲染出来，两种引擎共用；尽量不增加开发量。**

输入（先读）：
- Codex spike：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-codex-native-tui-spike-23ce/out/codex-native-tui-spike.md`（§2 TUI 驱动内核、§3 协议面清单、§4 映射不可逆、§5 治理冲突、§6 三路径估工、§7 与 Claude 线共用）与 `out/proto/` 的 18 行代理 PoC。
- Claude spike（已证伪原生 Claude TUI 直连）：`.fenjue/archive/fj-cc-native-tui-spike-0e0a/out/cc-native-tui-spike.md`（同前缀）。
- AS 代码：`packages/agent-server/src/{protocol,core,engines,server,transport}`，尤其 codex.ts / codex-mapper.ts 的每线程一进程模型与 raw 通知通道、approval-broker、lease-manager、claude.ts 的只读门。

要决定的事（给结论 + 理由 + 被推翻的判据）：
1. **入口形态**：AS 新增「Codex app-server 协议」ingress（ws:// 与 unix:// 两种，bearer token 走 HTTP upgrade），与现有 as/1 端口并存；每个 TUI 连接映射成一个 AS client identity（租约、审批 audience、审计归属怎么落）。
2. **进程模型**：Codex 线程走 native passthrough——保留每线程一进程并在 ingress 做 thread→进程路由与全局 list 聚合，还是改为共享一个官方 app-server 进程？以改动最小、能过 slice 1 为准，写清两者的迁移代价与不可逆点。
3. **Claude 线程在 Codex TUI 里怎么显示**：AS 需要模拟的 app-server 子集（thread/start、turn/start、item 通知合成、审批反请求、resume/历史）；从 AS Item 合成 native item 的映射表（agentMessage / reasoning / commandExecution / fileChange / toolCall / mcpToolCall / subAgent / webSearch / plan / error）；模型列表、审批策略与权限模式、slash 命令（/model /approvals /compact /review 等）在 Claude 线程上的映射或明确降级（返回明确错误，不伪成功）。
4. **治理插入点**：租约（TUI 不会发 lease/acquire 时的产品规则）、审批经纪人只提交一次并用 serverRequest/resolved 收口、readonly/model guard/allowed_roots/serviceTier=default 在 native 入口的落点；TUI 的副作用入口（config write、fs/write、command/exec、thread/shellCommand、plugin）哪些放行、哪些按策略拒绝。
5. **切片计划**（每单 ≤ 1 天，可独立验收，verify 命令可直接进 fj）：slice 1 = Codex 线程端到端（官方 TUI 连 AS：start / turn / 审批经 broker / resume / 中断）；slice 2 = Claude 线程显示与交互（同上动作）；slice 3 = 多线程列表 / fork / 历史分页 / 断线恢复；slice 4 = 治理硬化与升级回归（钉版本：TUI 0.153.4 + 协议 schema，升级回归脚本）。每单交付物、verify（含用 PTY 驱动官方 `codex --remote` 的冒烟脚本）、回退开关。
6. **agent-tui 退役路径**：fj 坐席显示端何时切到 `codex --remote`（fjContext、ready 握手、OSC 状态在新入口怎么给），agent-tui 只维护到哪一步。
7. 风险表：协议未钉版本漂移、TUI 多线程期望 vs AS 单线程 engine、帧大小 16 MiB vs 128 MiB、Unix NDJSON vs WebSocket、token 机制差异。

约束：方案总开发量目标 ≤ 8 坐席日（slice 1+2 ≤ 4 日）；不 fork Codex；不复制 as/1 与 native 双向全量转换。不改任何文件；临时文件只放 mktemp。
