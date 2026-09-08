# S144 · 2026-09-07 12:40 · 侧栏 worktree 展示诊断 + 方案 A 止血起跑

## 起因
用户截图：Trellis 侧栏一个 git 项目下平铺约 30 行 worktree，部分带灰色 `worktree` 标签、部分不带，橙色数字 1/2/69，随机名（worktree-calm-field-2b51）混在 issue 分支名里。原话「很多 worktree 的开发工作区特别混乱，worktree 相关功能都特别奇怪」。该项目不在本机真库（无 nav 项目），是另一台机器上的实例。

## 诊断（fj-wt-diag-a677，claude 只读，已验收归档）
产物：`.fenjue/archive/fj-wt-diag-a677/out/diagnosis.md`（规则清单 R1–R41 带 file:line、怪异点 A1–A15、根因、方案 A/B/C）+ 桌面/手机截图 + `synth-setup.sh` 复现配方（/tmp 合成仓 26 个 worktree + 隔离实例 3479）。

关键结论（A2、A6 leader 自核代码）：
- A2 **数据风险**：`lib/server/git-status.ts` isMergedInto 用 `.slice(1)` 把 merge 的第一父也算进去 → 主干出现任何 merge commit 后，零提交的 worktree 全被判「已合并」，BatchCleanModal 默认全选（含有会话的）→ `git worktree remove --force`。合成场景 19 候选 16 误判。
- A1 同目录两行：`workspaces.path` 按原串 UNIQUE，会话 cwd 与 git realpath 写法不同即分裂。
- A4/A5 排序倒挂：扫描登记把扫描时刻写成 `last_used_at`，零会话 worktree 压在有会话的上面；Picker「最近」同根因。
- A6 灰标签 `worktree` 实际条件是「无分支」= detached。
- 其余：命名目录/分支不一（R11）；会话全平铺（R27）；三处删除口径不一（A10）；prune 在已删目录跑从不生效（A15）。
- 根因：worktree 身份键没定（表=路径原串、git=realpath、用户=分支），且「目录存在」被当成「正在用」。

## 方案
A 只修 bug（~1 天）→ B 会话优先分层（~3–4 天，推荐）→ C 分支面板（1–2 周，不推荐）。用户尚未对 B 表态。

## 动作
- 计划新增 wt-diag（done）/ wt-fix-a / wt-review-a / wt-ship-a；plan goal 已改。
- 方案 A 已派：`fj-wt-fix-a-65ed` → codex `trellis-wt-fix-impl` @ w1X:p2，worktree `~/.herdr/worktrees/trellis/feat-worktree-hygiene`（分支 feat/worktree-hygiene，base 398d114），基线 verify 全绿（tsc / bun test / mobile-slim-shell / 端口锁）。
- 顺手清了 trellis workspace 里两个跑完未退位的 codex pane（ship-c、ship-d）。
- 修正对用户的口径：橙色 ●N = dirty 数，折叠灰数字 = 会话数。

## Next
- 等 wt-fix-a result → settle（progress 未提交文件会误报越界，stash 绕）→ 派 wt-review-a（可 --reuse trellis-wave1-review，但其 cwd 是旧 worktree，需注意基线）→ ship 前问用户。
- 用户拍板 B 后再加 wt-design/impl/review/ship 项。
- 仍待用户：Herdr 打通选 H/A；留用坐席与已合入分支清理；progress 提交许可。

## 追记 13:30 · 方案 A 交付 + 两轮 review
- `fj-wt-fix-a-65ed`（codex）交付 6 commit（260399d realpath 归一与幂等迁移 / c000aca 已合并只认第二父 / f1e8a9b 清理预演带会话数 / 9d74510 排序只吃真实活跃度 / dfb7d29 detached 标签 / c99e00f prune 在主 checkout），合成对照 nav 31→24 行、误判候选 19→3。验收自动过（worktree 隔离 → 不再被 progress 未提交文件误报越界）。
- review-a（claude，`fj-wt-review-a-13de`）：需返工。#1 高：update-branch（分支先 merge main 再被 merge commit 合入）下零提交 worktree 仍判已合并 → 判据改「is-ancestor ∧ tip ∉ first-parent 链」；#2 中：UI 新建的 worktree 也写 NULL 沉底、从「最近」消失；#3–#5 低（recent 合并丢较新时间戳 / 会话数口径 / prune 落点）。
- `fj-wt-fix-a2-c4ed`（codex，`-- -a never -s danger-full-access` 起位零弹窗）5 commit fd62ced…7dd061c。
- review-a2（reuse reviewer）：#1/#3/#4/#5 修对、反例打不穿；#2 修过头——discovered 行也写 now，backfill 场景下排序退化为插入序。派 `wt-fix-a3` 单修（只有 trellis 来源写 now）+ `wt-review-a3` 终审；ship 依赖改到 a3。
- 坐席实弹：codex 0.153 默认 Ask for approval，出 workspace 命令逐条弹；`/permissions`（非 `/approvals`）可切；起位带 `-a never -s danger-full-access` 最省事。launch 基线 verify 会留死 pid 的 `/tmp/trellis-mobile-verify.lock`。均已回填 seats.md。

## 追记 13:35 · 方案 A 终审通过，等用户点头上线
- `fj-wt-fix-a3-cc07` 一个 commit 6433cdd（只有 trellis 来源写 last_used_at=now；discovered/worktree-scan 写 NULL）+ 单测。
- `fj-wt-review-a3-a97d`（reuse reviewer）：**通过**。合成实例排序 rv-fresh(UI 新建) → issue-170(30 会话) → nav → 166 → …→ 17 个零会话行；87 tests pass；#1/#3/#4/#5 未被带回。两条固有残余记录在案（CLI 从 origin/main 建零提交 worktree 且本地 main 用 merge 方式 pull 后仍会判已合并；bare 仓 worktree 删除后 prune 落点空跑）。
- 分支 feat/worktree-hygiene 共 12 commit（相对 main 398d114），未 push。下一步 wt-ship-a：合并 + `make deploy REF=HEAD`，起位前问用户。

## 追记 14:25 · 方案 A 上线（PR #43）+ 收尾
- 用户「上吧」→ `fj-wt-ship-a-69b3`（codex，`-a never -s danger-full-access`）：推分支、PR #43 merge commit 92c6539、备份真库、`make deploy REF=HEAD` → release 20260907T061213-92c6539e4；leader 独立复核 HEAD=origin/main=release、网关 up/ready、lark 14:12 重连、真库不变量全过；prod 冒烟截图（桌面 1280 侧栏：trellis 主 checkout 18 会话在前、「✓ 已合并」组 4 条真合并分支、无 worktree 灰标；iPhone 15 抽屉正常）。
- settle 老坑：ship 单 HEAD 移动 + progress 未提交 → 改 task.json base_commit 到 92c6539e4 + stash progress 后 `settle --force` 7/7 绿。
- 收尾：retire 全部留用坐席（wave1-fix / wave1-review / wt-review）、关 diag 空 pane、移除四个已合入 worktree workspace（slim-shell / wave1 / header-hide / worktree-hygiene）；分支未删（等用户）。
- 用户顺手问 mermaid 不渲染：`D[本地 WARP 接口 (Socks5)]` 方括号内的圆括号是语法符号，用 mermaid 11.17 实测报 parse error，标签套双引号即可。

## Next
- 方案 B（会话优先分层：零会话 worktree 折成摘要行、分支名为主、会话只露最近 N 条、可清理组）等用户拍板。
- 仍待用户：Herdr 打通选 H/A；删已合入本地/远端分支；progress 提交许可。

## 追记 15:40 · Herdr 手机端接管方案调研（fj-herdr-mobile-research-c725，claude 只读，已验收归档）
- 产物：`.fenjue/archive/fj-herdr-mobile-research-c725/out/research.md`（Herdr 官方立场 / 8 个社区 Herdr 手机与 web 客户端 / Claude Code Remote Control / Happy / Omnara / opencode / transcript 浏览器 / 编排器 / codex 远程，每条带 URL）。
- leader 抽查官方 RC 文档（code.claude.com/docs/en/remote-control，本机 claude 2.1.258 有 `--remote-control`）：`/rc` 可在已运行会话开启并带走历史；`/config` 或 `remoteControlAtStartup: true` 全会话自动连；手机可答 permission prompt 与 AskUserQuestion；连接期间 transcript 存 Anthropic 服务器、不支持 API key；每进程一个远程会话、本地进程必须活着；`/resume` `/plugin` 仅本地。仅 Claude Code，不管 codex。
- 结论：Claude 坐席的「手机续聊 + 审批」官方 RC 已零开发覆盖；Trellis 只需做 Herdr 拓扑面板 + transcript 只读回放 + send-keys 回复（覆盖 codex 等），最接近的社区同构项目是 0cv/herdr-mobile-relay（AGPL，读原生会话文件 + 送键）。等用户定路线。

## 追记 15:55 · Orca 调研（fj-orca-research-e830，claude 只读，已验收归档）
- 产物：`.fenjue/archive/fj-orca-research-e830/out/orca.md`。Orca = Stably AI（YC W22）的 Electron 多 agent 工作区（Herdr/Conductor 同层），MIT，63k★，日更；本机 1.4.143 落后 54 版。结构化三层：hooks 事件流（状态/当前卡片/绑定）> transcript jsonl（正文）> 抓屏（兜底）；输入只走 PTY bracketed paste + 延迟 Enter；pane 身份靠自己 spawn 时注入 `ORCA_PANE_KEY`，hook payload 的 `session_id + transcript_path` 落盘反向绑定；**不能接管非它启动的会话**；官方 Orca Mobile（iOS/Android，QR 配对、E2EE、LAN/Tailscale 直连、可选托管 relay）；默认给 agent 加 `--dangerously-skip-permissions` 一类全自主 flag。
- 对我们方案的修正：状态与审批/AskUserQuestion 卡片走 Trellis 自己的 hook 接收端（sh+curl、token 文件、永不阻塞），正文仍 transcript 只读；pane↔会话绑定用 hook payload 的 session_id/transcript_path/cwd 反查 Herdr pane，或起位时注入 `TRELLIS_PANE_KEY`；codex 现有原生 hooks（features.hooks + hooks.json），可装同形 hook；不抄默认跳过权限；不自建 relay。
- 本机 Orca 的 hook 在 Herdr 起的 claude 里因无 `ORCA_PANE_KEY` 静默退出，互不干扰。

## 追记 16:10 · Herdr 打通开工（用户：单独分支，真机验证后上线）
- 计划 hb-probe（claude 只读，w1Y feat/herdr-bridge）/ hb-hooks（claude，w1Z feat/herdr-hooks）/ hb-codex-transcript（codex，w10 feat/herdr-codex-transcript）并行起；hb-core（after probe）→ hb-integrate → hb-ui → hb-review。设计定稿：Herdr socket 拓扑与送键、transcript 只读渲染、Trellis 自己的 hook 接收端出四态与卡片、会话归出生地、跨界即分叉；不做 relay/推送/账号；不默认跳过权限。
- 用户新问：要一个「Trellis 管家」页或对话，用聊天方式改项目编排设置。待答复与排期（可与 herdr-bridge 并行，仓内已有 skills/trellis-admin/scripts/trellisctl.ts 可复用）。

## 追记 18:00 · agent-server 立项（sm-toolkit）+ gpt-6-astra
- 用户拍板：参考 codex app-server 做 sm-toolkit 的 agent-server（daemon 独占引擎进程、item 日志广播、turn 排队、审批反向请求、多前端 attach、薄 TUI 客户端）。分支 feat/agent-server，Herdr worktree w22（`~/.herdr/worktrees/sm-toolkit/feat-agent-server`，源 workspace wR）。计划 as-design（opus）→ as-core → as-transport / as-codex-engine → as-tui → as-review。
- sm-toolkit 真仓 `~/sm-toolkit`（main 5610dfd，工作树有 5 个未提交文件，未动）；有 progress/（含 orchestra-rfc.md），设计要衔接。
- codex `gpt-6-astra` 在 `~/.codex/models_cache.json` 有真 metadata（GPT 6.0 Astra，effort low…ultra，272k），可作执行坐席模型：`-- -m gpt-6-astra`。
- Herdr 桥 UI 单进行中（侧栏分组、会话头、单驱动 lease、离线只读/重开、codex transcript 镜像已提交）。

## 追记 18:40 · Herdr 桥 review 需返工（fj-hb-review-4f44，opus，reuse 留用）
- 分支 feat/herdr-bridge 23 commit / 55 文件 / +7030 行；四个 mobile 脚本与 175 tests 绿，但 review 用反例打穿 3 条 P0：P0-1 `agent.wait` 被统一 5s 超时切断且 ETIMEDOUT 触发 markDown → 发消息几乎必败并把整个面板置灰；P0-2 cli-sync upsert 不更新 origin → 先手动 attach 再被 Herdr 接管的会话仍是 cli-import，/api/chat 闸失效 → 双驱动；P0-3 `pane.read` 解析不认 `result.read.text` → codex 读屏卡恒空。P1 七条（fake-herdr 形状/时序假通过、撤卡误撤、hook 状态无陈旧度、hooks/state 全量轮询、按键映射多余 Enter 有误批风险、reopen 会 split 别人的 pane、herdr 镜像会话灌进主列表）、P2 八条。
- 已派 hb-fix（codex gpt-6-astra，service_tier default）逐条修，repro 转正式单测；hb-review2 用留用 reviewer 重打。
- 真机试用通道：Tailscale 本机 100.102.237.93（iphone17 在 tailnet），局域网 192.168.10.134；隔离实例起在 3490 类端口即可手机直连。

## 追记 19:40 · 桥复核 review2 需返工（残留 6 条）+ agent-server 三单交付
- review2（fj-hb-review2-25ba）：上轮 18 条中 15 条真修好（反例打不穿）；残留 R1【阻断】单驱动真源 key 用错——herdr_sessions 按 pane 上报的 CLI sid，会话行是 lineage 根 sid，resume/fork 后不等 → 闸失效、herdr_alive 错、UI 显示离线且 reopen 404；R2【阻断】reopen 换了 split 目标却用目标 pane 的 cwd 起 resume；R3 审批卡无 tool_use_id 只能比 tool_name，父子同名工具互撤（修法：卡片带 agent_id）；R4 子卡覆盖父卡后 SubagentStop 复位条件恒不命中；R5 多问题 AskUserQuestion 的 needsReview 分支未校准（PLAUSIBLE）；R6 忙时前置 agent.wait 仍挂在 HTTP 路径（最长 300s）。已派 hb-fix2（gpt-6-astra）+ hb-review3（reuse reviewer）。
- agent-server：as-core（95 tests）、as-transport（unix/ws 传输、客户端库、daemon，138 tests）、as-codex-engine（假 app-server 回放，37 离线 + 全量 138）均验收；as-integrate 合并中。

## 追记 20:20 · 桥终审通过 + 起真机验证实例
- hb-review3（fj-hb-review3-8ad6，reuse reviewer）：**通过**。R1–R6 六个反例全部打不穿：双 sid 下闸返回 409、reopen 用绑定 cwd、父子同名工具不互撤、父卡复位、多问题卡实测停在 Submit 页需一次 Enter（calibration-03 留档）、忙时 0ms 受理 202 + queued→delivered 回执、深链冷启动 ~0.4s 且空闲不开 SSE。207 tests、四本 mobile 脚本绿。留 N1（P2）：排队链前一条失败连坐后一条且 composer 已清空 → 计划项 hb-fix3（验证实例起后再做，避免边改边构建）。
- 派 hb-verify-instance（codex）：独立 dist 构建、真 HOME、真库 .backup 副本（tasks/lark_bots 禁用）、3490、与 prod 同鉴权、TRELLIS_LARK=off、装 Claude hooks（备份 settings.json）；地址 Tailscale http://100.102.237.93:3490 / LAN http://192.168.10.134:3490。
- agent-server review（fj-as-review-05ca，opus）进行中：反例阶段队列/审批/租约/幂等/单引擎全部守住，已确认 2 个真问题（attach limit 被吞、按文档游标重连会丢断线期间的 item）。

## 追记 20:25 · 真机验证实例在线 + agent-server review 需返工
- fj-hb-verify-instance-a5bb 验收：3490 在线（bun，`*:3490`），gate up/ready；Tailscale http://100.102.237.93:3490 与 LAN http://192.168.10.124:3490（workspace.md 旧值 .134 已改正）均 200；真库副本 ~/.trellis/user-verify-3490.db（tasks/lark_bots 禁用），prod data.db 未动（mtime 06:27）、3088 健康；hooks 装入 ~/.claude/settings.json（11 条 trellis，Orca 10 条保留，备份 settings.json.bak-2026-09-07T12-16-48-874Z），端点文件 ~/.trellis/hooks/endpoint.env 0600 指向 3490；pid ~/.trellis/user-verify-3490.pid，日志 ~/.trellis/user-verify-3490.log。收尾：kill $(cat pid)；卸载 hooks：分支目录 `bun scripts/hooks/install-claude-hooks.ts --uninstall`。
- 用户试用步骤已发；N1 修复（hb-fix3）在同 worktree 源码上进行，不重建/不停 3490 实例。
- agent-server review（fj-as-review-05ca）：需返工。§一 安全：thread/start.env 可覆盖 PATH/ANTHROPIC_*（绕审批任意执行）；§二 契约：attach sinceSeq 丢断线期间完成的 item 正文、check-codex-alignment.ts 缺席且 codex 未知 item type 拆 thread、attach limit 被吞、测试非 hermetic（HOME 外 23 条红）；§三 低：db 0644、WS 无 Origin 校验、resume 未知 id 用 daemon cwd、孤立帧拆 thread、无 threadId 的 error 通知被丢。已派 as-fix（gpt-6-astra，env 字段删除方案）→ as-review2（reuse smtk-as-review）。
- 20:34 hb-fix3（N1：排队链失败不连坐、composer 收 delivered 再清空/失败还回文本、listHerdrBindings 去重）验收通过；3490 实例保持原 PID 在线。桥分支到此功能完整，等用户真机反馈 → 合并前需用最终 HEAD 重建并再跑一次全套脚本。

## 追记 21:05 · agent-server v1 复核通过；手机白屏排查
- as-review2（fj-as-review2-29f0，reuse opus）：**通过**。12 条全部修好且原探针反转：env 字段彻底删除（strictObject，未知字段 -32602，旧库 options 回灌被忽略）；断线补齐改为服务端 completedSeq（client 删掉回退补丁，protocol.md §8.2 重写）；codex 对齐脚本能对 4 种漂移变红；attach limit、hermetic 测试、db 0600、WS Origin、resume 必带 cwd、孤立帧不拆 thread 等均验。新增 N1 低危自愈 → backlog。分支 feat/agent-server HEAD 85e5b07，未 push。
- 收尾：retire smtk-as-review；移除已合入的 w23/w24 worktree（feat/agent-server-transport、-codex 分支保留）。
- 用户反馈 Tailscale 地址白屏：服务端用 iPhone 视口无头浏览器登录与首页均正常；根因是本机 Tailscale 显示 iphone17 offline（iOS 单 VPN，代理开着会顶掉 Tailscale）。已告知开 Tailscale 或走 LAN http://192.168.10.124:3490。
- 21:10 as-fix2（agent-server N1）验收通过：server 217、TUI 23、HOME=/tmp 全绿；feat/agent-server 无已知缺陷，未 push。所有单收口，无在跑坐席；留用坐席仅 trellis-hb-review（等用户手机反馈后可能的返工）。3490 验证实例继续在线。
