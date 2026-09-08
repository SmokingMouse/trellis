# S157 · 2026-09-08 12:00–13:30 · 阶段 2 收官（Claude 坐席 11 过 11）；只读门两轮真机 P0；agent-tui 路线定为 OpenTUI 渲染层

## 阶段 2 结论（对照 dogfood 方案 §7 退出标准）

| 标准 | 结果 |
|---|---|
| 连续 10 单无 AS 契约/控制消息丢失或重复 | 11/11（doc-audit、doc-fix、readonly-allow、-fix、-fix2、skill-docs-sync、cc-tui-design、readonly-allow-review3、readonly-gate-fix、readonly-gate-review、mobile-wave3-nits），零丢失零重复 |
| 无审批卡死 | daemon 权限映射 P0（S154）修后零卡死；Claude 坐席一律 `--permission full`，只读契约靠 settle 越界审计兜底 |
| 同线程仅一个引擎 | 每单 thread 唯一；复用坐席（smtk-roa-review2）连续 3 单同 pane 不同 thread |
| settle 首轮通过率 ≥ native 基线 0.75 | 10/11（mobile-wave3 首轮因 safe-area 脚本在高负载下环境性失败，main 基线同样失败） |
| 基础设施失败 | 退掉工作区最后一个 pane 致 workspace 消失（1）；同 worktree 并行单的未提交改动让只读单 settle 误判越界（eval、plan 各 1，base 重置后过）；busy 线程拒关需先 C-c；codex `--permission readonly` 沙箱不能落盘（改 full 重开）；`fj task launch --force` 不许改已持久化 permission |

**判定：阶段 2 通过。** 并发已实际到 5 席同跑（阶段 3 目标），daemon 未见瓶颈。

## 只读门线（agent-server）

- fix2（白名单解析器）通过 → 三审：解析器 186 例零绕过，但真机打出门外 P0——readonly 作为 CLI plan 别名时 Bash 不回传 can_use_tool，`touch` 无审批落地零留痕 → 裁决「只读由 daemon 强制」（decisions.md）→ gate-fix（eb2416e：readonly=default 模式 + ask 全部 + disallowedTools + 经纪人拒写；独立 bash turn 加门；顺手 P2-1/3/4，P2-5 留待专项）→ 四审：主线成立，但补丁新增两 P0（门与 `readonly_auto_allow` 开关绑死→关开关反而无门；default/acceptEdits 独立 bash turn 无审批）+ P1（readonly 拒写审计行真机不可达）→ gate-fix2 在跑（裁决：开关只管免审、永远不管有无门；五模式 bash turn 全过经纪人，bypass/dontAsk 留审计行）→ review2 待起（复用 Opus 坐席）。
- daemon pid 19156 仍是模型守卫版 dist；等 gate 线收口后重建重启（重启会断所有在跑线程，须等坐席空闲）。

## agent-tui 路线（用户：不从零开发，尽量复用）

- 源码解构（Opus，62 KB）：Claude Code 自造渲染引擎（packed cell + damage + blit + 硬件滚动）+ DOM 语义层 + action 级键位 + 虚拟列表；三套远程形态都是后补的，REPL 单体 5005 行承担四种后端；给「照抄 21 / 不要 8 / 绕开 9」三表与最短路径。
- 自审（codex，43 KB）：agent-tui 为自绘 ANSI，每帧全量排版，10000 条单帧约 155 ms；保留协议客户端/租约/去重/审批握手/会话逻辑，替换渲染与编辑器，拆 controller，Claude 专属语义下沉适配层；PTY harness 可复用、屏幕断言不可。
- 开源评估（codex，同机基准 2000 帧）：OpenTUI React 完整历史 p50/p95 0.19/0.25 ms、每帧约 115 B；Ink 窗口化 18/26 ms；现有渲染器 32/34 ms、每帧 4.7 KB。opencode TUI 独立成包但 151 文件 27035 行、112 个 SDK 调用点/80 接口/50 事件 case、启动硬等四类请求，薄 fork 估 16–24 单；A-OpenTUI（渲染层 + 自写组件、移植 controller）估 8–12 单；pi-tui 7–11；Ink 10–16。三个待验证点：真实终端 IME/候选框、真实变高历史虚拟化、Bun 编译发布与背压。
- leader 推荐（已告知用户并注入方案单）：OpenTUI 渲染层 + 自写组件，opencode 只作组件设计参考，不整体 fork；React vs Solid 渲染器由方案给取舍。方案单 tui-adoption-plan（Opus）在写，出稿后用户拍板再拆实现单。
- 许可证：OpenTUI/opencode/pi MIT，gemini-cli/codex/goose Apache-2.0，crush 非 OSI；Claude Code 源码只做设计参考。

## 其它

- mobile-wave3-nits 通过（C2-1/C2-2/C2-3/H-3，分支 feat/mobile-nits-wave3 @ f7dba61，未 push）；safe-area 脚本高负载失败记 backlog `mobile-safe-area-flaky`；机器上 4 个非当前任务的 agent-browser 守护进程（default / mv-as-project-71361 / mv-as-project-80774 / ship-c）待用户点头清理。
- mobile-wave1-nits（N-1/N-2/N-3）已起（trellis-nits1 @ w2G）。
- 安装副本 herdr-leader 已打 skill-docs-sync 的 patch（新增 references/runners/agent-tui.md）；seats.md 追加 codex 只读沙箱与 C-c 键名实弹。

## Next

- gate-fix2 → review2 → 重建 dist、等坐席空闲后重启 daemon；P2-5（find/rg/grep/file 白名单化）另开单。
- 方案单出稿 → 用户拍板渲染器与阶段拆解 → 起第一阶段（instrumentation + 基准 + 三个不确定点验证）。
- wave1 验收；合并类事项仍等用户：Herdr 桥、影子模式与第二步、agent-server 合 main 与发包、daemon 常驻、mobile-nits 两分支。
