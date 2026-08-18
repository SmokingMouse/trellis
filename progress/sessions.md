# Session Log

最近 5 条，倒序（Session 105 / 104 / 103 / 102 / 101）。更早的见 `archive.md`。

### Session 105（2026-08-18，codex 权限卡 + 子 agent Task 树：SDK 0.7.0 + trellis 三闸放开）
- **触发**: S104 交付后用户「开始做吧」——下一批：审批回调、turn/steer、子 agent Task 树。
- **Done ① SDK 0.7.0**（已发 npm，干净 worktree 构建发布防并行 WIP 混入）: 审批——`permission "default"` + onCanUseTool → codex `approvalPolicy untrusted`，`requestApproval` RPC 映射成 claude 形状回调（commandExecution→`Bash` 带裸命令 / fileChange→`Edit` 带 diff），allow→accept / deny→decline / abort→cancel；权限确认模式 preflight 失败 fail loud 不再静默回退 exec（安全语义降级）。multi-agent——**修 0.6.0 潜伏 bug**（子线事件同连接到达，不过滤则子线 turn/completed 提前终结 run、子文本混主答）；`subAgentActivity`→spawn_agent 工具卡 + Task started/completed（taskType local_agent，summary=子线终答），子线工具挂 parentToolUseId。SDK 单测 48/48、审批 e2e 3/3、回归 e2e 11/11。
- **Done ② trellis**: 三闸放开 codex——`approvalAvailable`（mock 除外）、route 创建钳制、`interactive = claude || codex`；AgentPicker / settings 文案同步（Codex 支持逐项审批）；InteractionForm 零改动（Bash 命令块 / 通用 JSON 兜底本就按 toolName 渲染）。tsc 零错。
- **Done ③ steer 推迟**: 树模型无消费位（一节点一问一答），决策记 `decisions.md` 2026-08-18 条。
- **验证与插曲**: trellis 全链（makeCodexProvider→SDK→codex）实测**审批回调触发 + accept 后命令真执行 + shell 工具卡到达**；但完整轮次撞上 cpa 的 codex 上游 `503 auth_unavailable` 间歇故障（当日内从间歇恶化为挂起，判别实验证明与本次改动无关：默认 provider 同轮次全通、exec 同注入同 503）→ 记 `failures.md` 待查（修复大概率在 cpa 服务端补池凭证）。
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

### Session 102（2026-08-18，codex picker 补 endpoints.yaml 第三方端点枚举，PR #16）
- **触发**: S101 修通了本机 canonical yaml 的 codex 标记后，picker 仍选不到 yaml 里的第三方模型——`codexProviders()` 只读 `~/.codex/models_cache.json`，没登录过 ChatGPT 的机器只剩裸 `codex`（默认 gpt-5.5），带 `codex: { wire_api: responses }` 标记的端点模型（resolveCodexModel 可 `-c` 注入、无需登录）在 UI 上不存在。
- **Done**（`app/api/providers/route.ts`，分支 `feat/codex-picker-yaml-endpoints`，PR #16 base main）: `codexProviders()` 改双源合并——新增 `codexYamlProviders()` 用 `loadEndpoints()` 原始 ConfigFile（不走 `listEndpoints`，EndpointInfo 不带 codex 块）枚举带标记 provider 的 models → `codex:<model>`（label `codex · <provider> · <model>`，hasKey = `process.env[api_key_env]` 有无）；models_cache.json 读取拆成 `codexCacheProviders()` 失败返回 `[]`（不再连带吞掉 yaml 来源）；按 id 去重 yaml 优先（与 resolveCodexModel 的 yaml 精确命中优先一致）；裸 `codex` 条目保留最前（DB 旧会话 model="codex" 按 exact id 查显示）。
- **验证**: tsc 零错；临时 export + `SM_ENDPOINTS_PATH` 指临时 yaml 三场景实测（bun --conditions react-server）——带标记 provider 2 模型出现且 hasKey 随 CPA_API_KEY 有无翻转、不带标记 provider 不出现、`HOME` 指空目录（无 models_cache）时 yaml 枚举仍工作、合并后无重复 id；eslint 与 git stash 基线对照零新增；`bun run test:codex-cli` ALL PASS。
- **插曲**: `~/.agent-gateway.env` 某行值含未闭合引号，zsh `source` 整体失败（它是 dotenv 格式非 shell 安全格式）——测试时改用 grep 单行提取 CPA_API_KEY 注入。
- **Next**: PR #16 review 后合 main；部署走 devbox（本机不部）。合并部署后用户在 picker 选 `codex:gpt-5.6-sol` 之类真机验一轮（衔接 S101 Next 的 `codex:gpt-5.5` 真机确认）。

### Session 101（2026-08-18，codex 第三方端点本机失效：canonical endpoints.yaml 缺 codex 标记）
- **触发**: 用户截图会话 `cd2ca8d2`（model `codex:gpt-5.5[1m]`）报「codex 未登录(ChatGPT)…endpoints.yaml 端点需带 codex: { wire_api: responses } 标记」，问「现在好像不支持 codex 第三方登录」。
- **根因链**: ① trellis 把 `codex:*` id 路由到 SDK CodexBackend，slug = `gpt-5.5[1m]`；② SDK `resolveCodexModel` 以 openai 协议解析 endpoints.yaml —— 该 slug 精确命中 yaml `codex` provider，但它只有 `anthropic_url`（→ 127.0.0.1:18765，**代理已死**：无监听、无 systemd/启动脚本），无 `openai_url` → throw 被 catch 吞成静默透传；③ 透传撞登录闸 `codex login status`（本机从未 ChatGPT 登录，只用静态 key provider）→ 报错。④ 修法（cpa 加标记）S96 已做过，但只落在 legacy `~/.claude/global/endpoints.yaml`（随 git 同步到本机）；**搜索顺序优先的 canonical `~/.config/sm/endpoints.yaml`（8-10 建，含 modelhub/traex 等机器专属 provider）从没移植该标记**——两份 yaml 已分叉，canonical 是生效的那份。
- **Done**: canonical yaml 的 `cpa` provider 加 `codex: { wire_api: responses }`（带注释）；用户拍板后删掉死 `codex` provider 条目（18765 代理无监听无启动脚本，`CODEX_AUTH_TOKEN=unused` 一并从 env 清掉）；`HOME=/data00/home/zhangpeng.pada make deploy` 重部 prod（同 sha `a9d67a356`，smoke 全绿）让 SDK 重读 yaml。
- **验证**: ① CPA `/v1/responses` 直连实测 `gpt-5.5` 可用；`gpt-5.5[1m]`/`gpt-5.5-fast[1m]` CPA 不认（unknown provider）；② 按 SDK 注入参数裸跑 `codex exec`（sm_endpoint + CPA_API_KEY）turn.completed 正常；③ `resolveEndpoint(..., "openai")` 实测 `gpt-5.5`/`gpt-5.6-sol` → cpa + 标记 + key present；删条目后 yaml 仍合法、`codex` provider 已不在列表；④ 重部后 prod smoke 全绿（含 /api/providers）。
- **遗留**: ① 旧会话 `cd2ca8d2` 的 `[1m]` slug 无解（yaml 已无此模型，CPA 也不认），新会话选 `codex:gpt-5.5` 即可；② `modelhub` provider 随 LiteLLM :4000 今天删除已死，待清（modelhub-proxy:3456 是另一个东西，还活着）；③ SDK 登录闸对「config.toml 配了静态 key 默认 provider」的机器是假阴性（透传本可跑），根治要改 sm-toolkit；④ models_cache.json 若被 CLI 重建，`[1m]` 类 slug 仍会撞闸（不在 cpa 列表），plain slug 不受影响。
- **Next**: 用户新开会话选 `codex:gpt-5.5` 真机确认一轮。
