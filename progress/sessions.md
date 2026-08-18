# Session Log

最近 5 条，倒序（Session 107 / 106 / 105 / 104 / 103）。更早的见 `archive.md`。

### Session 107（2026-08-18，权限确认升级全拦：agent@0.8.0 + READONLY_AUTO_ALLOW 免审名单）
- **触发**: PR #15（并行会话的 askTools "all" + mcpServers 一等协议）review 合并、SDK 发 0.8.0 后，trellis 接力吃下全拦。
- **Done**: ① bump `^0.8.0`；② `sdk-adapter` 的 `APPROVAL_ASK_TOOLS` 名单换 `"all"`（CLI `permissions.ask:["*"]`）——旧名单外的可变更工具（MCP 工具是最大的洞，`mcp__*` 名字穷举不完）此前被全局 allowlist 静默放行；③ 「哪些免审」的判断挪进 run-bus dispatcher：新增 `READONLY_AUTO_ALLOW`（Read/Glob/Grep/LS/WebFetch/WebSearch/TodoWrite/NotebookRead/BashOutput/Task/Skill/SlashCommand），权限确认下只读/编排类自动放行、其余一律弹卡；Task/Skill 外壳放行不漏审——内部可变更调用各自再进回调逐个弹卡。
- **验证**: 真机 claude 走 trellis provider 层 + requireApproval：回调收到 `["Read","Bash"]`（Read 旧名单下直接绕过、现在进回调）、放行后回答 DONE；tsc 零错、eslint 改动文件零输出。agent@0.8.0 由干净 main 构建发布（PR #15 内容 58/58 复核）。
- **版本归属澄清**: maxTurns/skills 两项实际已随 0.7.0 出包（并行会话在 0.7.0 发布前落的 main）；0.8.0 增量 = askTools 全拦 + McpServerConfig。
- **Next**: 真机权限确认会话验弹卡范围（Bash/Edit/MCP 弹、Read 不弹、「总是允许」仍生效）；cpa codex 上游故障（failures.md）恢复后复验 codex 注入路径。

### Session 106（2026-08-18，agent 长任务正文一坨糊：分段 + 过程/结论分层，PR #17 已合并）
- **触发**: 用户截图「正文+思考+正文……会导致正文的阅读体验特别差」——TurnCard 把几十段过程叙述连成一坨。
- **根因**: SDK 逐 token 透传 `text_delta`、content block 边界零事件，run-bus `committedText += text` 无缝拼接；cli-import 路径早有 `join("\n\n")`，只有 live 流式路径中招。
- **Done（一个状态机两层；worktree `calm-river-7881` → PR #17 → main `30df25a`）**: ①**分段**——run-bus 在结构性中断（thinking / 主链 tool_call_start）后的下一个 delta 前把 `"\n\n"` 当普通 delta 走完整路径（commit + DB append + broadcast），流式端/落库/catchup 快照三方天然一致，claude/codex/mock 通吃；延迟到「确有新正文」才插，工具收尾的 turn 不留尾部垃圾。②**分层**——同一状态机维护 `finalStart`（最后一次中断之后的正文起点）落新列 `nodes.final_start`（NULL/0 = 不分层 → 存量/纯 chat 渲染逐字节不变），TurnCard done 态把过程叙述折叠成弱化 details（「🧭 过程叙述（N 字）」，小号墨色+左竖线），最终答复才是正文；分享卡片图只带最终段，复制全文仍全文。cli-import 按块结构精确算同一偏移（thinking 块仍丢内容但当中断信号），retry 重置清零，done 事件/DB-fallback 重连都携带 finalStart。
- **验证**: 新回归 `scripts/test-final-start.ts` 9/9（mock provider 驱动真实 startRun/subscribe + 手造 jsonl：分段串、落库偏移、done 携带、纯回答不分层、工具收尾指向末段）；真实数据最近 60 个 CLI jsonl / 369 turns → 243 分层、**0 越界/空最终段**，抽样最终段全是 TLDR/交付汇报类收尾；隔离 dev（`TRELLIS_DB_PATH` 临时库 + :3210）+ agent-browser 截图折叠/展开两态符合设计；tsc 零错、eslint 零新增（TurnCard 4 条既有基线）、`bun --bun run build` exit 0（裸 `bun run build` 无 `--bun` 会在 collect page data 阶段挂 `bun:sqlite`——Makefile:5-9 与 facts.md 早有记载，别绕过 make）。
- **边界（刻意不做，记 PR body）**: 锚点/搜索命中过程段时 details 不自动展开（锚点几乎都在答案区）；流式态不分层（有 thinking 面板与动线顶着）。
- **Next**: **未部署**（已进 main，下次 `make deploy` 自然带上）；部署后用户开一轮真 agent 长任务看 done 态「过程叙述折叠 + 结论正文」效果。

### Session 105（2026-08-18，codex 权限卡 + 子 agent Task 树：SDK 0.7.0 + trellis 三闸放开）
- **触发**: S104 交付后用户「开始做吧」——下一批：审批回调、turn/steer、子 agent Task 树。
- **Done ① SDK 0.7.0**（已发 npm，干净 worktree 构建发布防并行 WIP 混入）: 审批——`permission "default"` + onCanUseTool → codex `approvalPolicy untrusted`，`requestApproval` RPC 映射成 claude 形状回调（commandExecution→`Bash` 带裸命令 / fileChange→`Edit` 带 diff），allow→accept / deny→decline / abort→cancel；权限确认模式 preflight 失败 fail loud 不再静默回退 exec（安全语义降级）。multi-agent——**修 0.6.0 潜伏 bug**（子线事件同连接到达，不过滤则子线 turn/completed 提前终结 run、子文本混主答）；`subAgentActivity`→spawn_agent 工具卡 + Task started/completed（taskType local_agent，summary=子线终答），子线工具挂 parentToolUseId。SDK 单测 48/48、审批 e2e 3/3、回归 e2e 11/11。
- **Done ② trellis**: 三闸放开 codex——`approvalAvailable`（mock 除外）、route 创建钳制、`interactive = claude || codex`；AgentPicker / settings 文案同步（Codex 支持逐项审批）；InteractionForm 零改动（Bash 命令块 / 通用 JSON 兜底本就按 toolName 渲染）。tsc 零错。
- **Done ③ steer 推迟**: 树模型无消费位（一节点一问一答），决策记 `decisions.md` 2026-08-18 条。
- **验证与插曲**: trellis 全链（makeCodexProvider→SDK→codex）实测**审批回调触发 + accept 后命令真执行 + shell 工具卡到达**；但完整轮次撞上 cpa 的 codex 上游 `503 auth_unavailable` 间歇故障（当日内从间歇恶化为挂起，判别实验证明与本次改动无关：默认 provider 同轮次全通、exec 同注入同 503）→ 记 `failures.md` 待查（修复大概率在 cpa 服务端补池凭证）。
- **部署**: `make deploy` 上线 `66ebf0425`（smoke 全绿，prod node_modules 实核 0.7.0）。
- **Next**: cpa 池恢复后按 failures.md 判定命令复验注入路径；用户真机 project+需确认开 codex 会话点权限卡、multi-agent 提问看 Task 树；审批「总是允许」按 toolName 已复用 claude 机制无需改。

### Session 104（2026-08-18，codex 逐 token 流上线：SDK 0.6.0 app-server transport + trellis bump）
- **触发**: 用户问「codex provider 不支持 stream？工具和子 agent 也没有？」。调研（两 research agent 挖 openai/codex 0.147 源码 + 本机协议探针）：exec --json 的 delta 是输出层**有意丢弃**且无 flag 可开；0.147 起 v1 协议移除、v2 唯一默认，官方全生态（TUI/exec/VS Code 扩展/Python SDK）已收敛到 app-server；实测 app-server `thread/resume` 直接续 exec 录的 rollout（同一存储、id 互通）。SDK 侧 08-04 推迟决策的重启条件「v2 收敛」已满足 → 解除。
- **Done（全在 ~/sdk，trellis 零代码改动）**: `@smokingmouse/agent@0.6.0` 发 npm——CodexBackend 默认 app-server transport（per-run spawn stdio JSON-RPC v2）：`item/agentMessage/delta`→TextChunk 逐 token、reasoning→Thinking、item 生命周期→ToolCall/Done（**含 collabAgentToolCall 多 agent**，S99 时代「codex 子 agent 不可见」随之闭环）、原生 `thread/fork` 替代 rollout copy、abort→`turn/interrupt`；preflight 失败零事件回退 exec（prompt 绝不跑两遍），`environmentSkills=false`/`extraArgs`/ephemeral resume 预分流 exec。trellis 仅 bump `^0.6.0`（package.json + bun.lock）。
- **验证**: SDK 单测 40/40 + 真机 e2e 10 项（流式 100 chunks vs 强制 exec 1、fork 隔离、readonly 拒写/workspace-write 圈内/full 圈外逐档=exec 语义、abort 5.5s 收尾）；trellis node_modules 冒烟：capabilities `streaming:"token"`、真跑 app-server 23 chunks。sm-toolkit 三 commit 合并推送 + release commit（`9eff060`、`25b5cc0`）。**本机已部**：`make deploy` 上线 `85fd082e4`（smoke 全绿，f106885→85fd082 连带 S99–103 改动一起上线），prod node_modules 实核 0.6.0。
- **边界**: 审批回调（dynamicPermissionCallback）仍未接——S99 边界里「Codex 不能弹逐项审批卡」只解了 transport 层，approval RPC 映射是下一个独立 phase；`turn/steer`、`subAgentActivity`→Task 树渲染同理。S101 遗留 ③（登录闸假阴性）未动。
- **Next**: 用户真机开 codex 会话看打字机效果（顺带 S100 Tab 切换体感 / S103 长树图形视图两项待验收）；devbox 侧下次 `make deploy` 自动带上 0.6.0（bun.lock 已锁）。

### Session 103（2026-08-18，树面板图形视图长树密到糊：缩放下限 + 滚动 + 锚点跟随）
- **触发**: 用户截图「BOE GPU部署sub2a」82 节点树的图形视图——点全挤成一串珠子，「这个节点也太密集了」。
- **根因**: `TreePanel` graphGeometry 把整树等比压进 `GRAPH_MAX_H=300px`。dagre compact 层距 126px（90+36），长链树布局总高数千 px → scale 被压到 ~0.03，层距 3-4px < 点直径 7px，必然重叠。
- **Done（`components/TreePanel.tsx`）**: 纵横分开缩放——`scaleX` 仍贴合面板宽（272px，不出横向滚动条），`scaleY` 优先塞进 300px、塞不下时守住下限 `GRAPH_MIN_SCALE_Y = 12/126`（层距 ≥12px），高度溢出交给外层 body 的 `overflow-y-auto` 滚动。配套：锚点节点加 `data-graph-active`，切图/跳转后 `scrollIntoView({block:"nearest"})` 跟随，否则长树切过去看到的是树顶一屏灰点。
- **验证**: tsc 零错、eslint 该文件零输出。真机视觉效果待用户看。已合并推送（`39ff175` → merge → push origin/main），**未部署**。
- **Next**: 用户在真机开同一棵 82 节点树的图形视图确认：点间距可读、滚动顺、当前点在视口内。
