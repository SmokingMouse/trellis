# S159 · 2026-09-08 14:45–17:30 · codex-ingress 第一片收口、第二片返工中；agent-tui 急救终审通过并切 bin；内存清理

## codex-ingress（单一 TUI = Codex 官方 TUI 经 AS）

- 方案（Opus）：独立 `codex-ingress` listener（ws:// + bearer，unix:// 推到 slice 4）、每线程一进程 + control 进程、Claude 线程单向合成、租约按需、审批经 broker 用 resolved 收口、副作用方法白名单 fail-closed；四切片 7 坐席日。已记 decisions。
- slice 1（codex）：首轮验收挂在时序（fixture 回得太快，interrupt 打到已结束的 turn）与 thread/name/set 未支持 → 返工去时序依赖、按上游 0.153.4 核 interrupt 语义、命名持久化、连跑 5 次 → 通过。Opus 复核 41 项反例全过但抓到 P1：**零 turn 线程 resume 报 list_turns 未实现**（fj 主路径：fj 用 as/1 建线程 → TUI resume 进去）→ 返工实现 turns/list 与历史分页、冒烟加 resume_fresh_ok → 二次复核独立重打零 turn / 1 轮 / 多轮分页恢复，通过。
- slice 2（codex）：Claude 线程在官方 TUI 显示与交互交付（7b07f8f，自报 partial），真机证据齐（零 turn 恢复、新建 Claude 线程、按 y 经 broker 写文件、自动命名、退出后恢复、流式中 Esc 中断）。三条协议差异由 leader 裁决（decisions）：通用工具审批投影为 tool/requestUserInput、live effort 明确错误、multiSelect 投影为自由作答。Opus 复核：功能面合格（sonnet 六判据开闸后 3/3、合成逐字段一致、41 反例零回归），P1 = 交付默认态下 `claude_threads` 闸关闭致契约冒烟 0/3 → slice2-fix 在跑（接手退位坐席留下的 stash WIP、开关落地并让冒烟对 claude 后端开闸、三条裁决、P2×3）。
- 实弹：退位坐席时它仍在按补充要求改代码，留下未提交 WIP 让只读复核误判越界（stash 后 settle 通过）；留用坐席空闲 ~20 分钟后 agent-tui 的 Herdr 上报超时被注销、`--reuse` 失败（backlog `agent-tui-herdr-reporter-timeout`）；`fj reply` 里的反引号会被 zsh 当命令替换吃掉。

## agent-tui 急救线收口

- 一审 P1×6（状态头仍 3–4 行、Read/Grep 非单行、空 reasoning 占行、失败退出码丢失、折叠按逻辑行、NO_COLOR 下测试红）→ fix → 二审只剩 P1-5（超长行折叠回吐 2484 行）→ fix2（按最终显示行预算）→ 终审通过（64 组 5000 字符矩阵 ≤ 8 行、双环境 182 测试、324 格矩阵）。policy `agent_tui_bin` 已切到 feat/tui-display-quickwin（过渡期，ingress 落地后退役）。

## 其它

- 内存：整机 69 GB 空闲 67%，压缩 17.7 GB；清掉复核测试留下的孤儿 Claude 引擎（320 MB）与空闲留用坐席（~590 MB）；大头是 Docker VM 2.3 GB、harbor daemon ~1 GB、Edge/飞书、leader 会话 842 MB；3490 验证实例 712 MB 待用户点头停。
- 用户问「为什么 TUI 还是原始的」：切换只对之后新起坐席生效（已核第二片坐席面板为折叠版）；根治是 ingress 落地后显示端改 `codex --remote`。

## Next

- slice2-fix → Opus 复核 → slice 3（多线程 / fork / 分页 / 断线）→ slice 4（治理硬化 + unix:// + 升级回归）→ fj `--runner codex-tui` + 删 ready-file 协议 + Herdr reporter（0.8 日）→ agent-tui 退役。
- 用户待决：桥 / 影子与第二步 / mobile 两分支合并、AS 合 main 与发包、daemon 常驻、3490 实例停。
