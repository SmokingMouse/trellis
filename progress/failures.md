# Open Failures

## 待查

- **疑似通用空会话 hydrate 中止**（fj-as-adopt-a06a 发现，按主控裁定列为非本单引入的待查问题）。症状：GET /api/sessions/<empty> 返回 200、nodes=[]，前端五秒后提示 hydrate failed: signal is aborted without reason。可证伪假设：初始化/深链请求超时导致目标空会话未进入 store，根因未确认。历史判定命令：提交 a991584 上统一前缀执行 `sh scripts/mobile-verify/mobile-as-adopt.sh`，证据 out/adopt-e2e-final.log 与 failure.png。原用例三次失败曾触发停机；主控随后授权继续且仅收编至少一个 turn 的线程，本单不修 hydrate。新 E2E 改验零 turn 不建会话、首轮后五秒内收编，exit 0；此结果不表示通用空会话问题已修复。

- **cpa 的 codex 上游间歇 `503 auth_unavailable (providers=codex)`，且当日内恶化为挂起**（S105 发现）。症状：`codex:gpt-5.5` 类注入模型（sm_endpoint / `CPA_API_KEY` bearer）多请求轮次约半数请求 503、codex 内部 5 次重试常耗尽 → turn failed；晚间进一步退化为请求挂起（probe 120s 超时无事件）。**已证伪**：本机 key 过期（curl 同 key 直打 `/v1/responses` 200）、SDK 注入参数错（单请求轮次曾成功 + S101/S102 同参数实测过）、0.7.0 代码回归（`transport:"exec"` 同注入同 503 模式）。**可证伪假设**：cpa（vultr-tokyo cliproxyapi）把 codex 形状流量路由到「codex」OAuth 池，该池凭证耗尽/过期；config.toml 的 cliproxyapi provider（同 key + `requires_openai_auth=true`）当时仍通，或因路由到不同池。**判定命令**：池恢复后跑 `node /tmp/codex-inject-probe.mjs d`（挂了随时可从 S105 session 记录重建）——稳定 completed = 池问题坐实；仍 503 而 config.toml 路径通 = 需比对 cpa 侧对两种 provider 配置的路由差异（`requires_openai_auth` / provider name）。修复大概率在 cpa 服务端（补 codex OAuth 池凭证），不在 trellis/SDK。

## 已结案

- **待办跨会话导航约 5 秒超时，重复整页打开后 hydrate 退回空页**（fj-pending-bar-5cfe）→ `resolved`。症状：浏览器 `/api/sessions/<id>` 两次约 5.1 秒失败，provider catalog 同时报 AbortError。假设「pending 聚合连接 AS 阻塞响应」被证伪：聚合原本只读 SQLite，故障当时 curl 网关 2.6ms、Next 1.6ms，Server-Timing total 0.28ms；浏览器失败请求 requestStart/responseStart 均为 0，旧页面三组 SSE 占满 HTTP/1 连接。给全局 SSE 增加 pagehide 取消与 BFCache 恢复后，浏览器请求约 2–3ms；另以导航所有权阻止过期 hydrate 覆盖当前会话，真正超时仅重试一次。判定命令：指定隔离 env 前缀运行 `sh scripts/mobile-verify/mobile-followup-approval.sh`，包含 resource timing <300ms、手机第二项和桌面跨会话断言。证据：主仓 `.fenjue/tasks/fj-pending-bar-5cfe/out/mobile-followup-approval-final.log`、`server-timing-gate.txt`、`server-timing-next.txt`。此记录只结案本次可复现路径，不据此结案上方尚未独立复现的历史空会话问题。

- **波四地图的网格掩盖父子关系，小图标题不可读**（fj-canvas-map-layout-3a3c）→ `resolved`。症状：6 节点链被排成多列网格，边绕到标题栏，默认缩放仍截断小字。可证伪假设：深度优先序号直接映射网格坐标，同时退化阈值 1.15 高于自动适配上限 1。复用 dagre 层级树、层间正交连线，改为真实视口居中适配与 0.9 退化阈值后，指定 6/124 节点快照两端全部入屏，边零交叉零穿卡。判定命令：`bun test lib/canvas-map.test.ts`；生产快照几何证据：`bun /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-canvas-map-layout-3a3c/out/geometry.ts`。两次 flag 构建、同视口截图与 proof 见同目录 `result.md`。

- **收编事件 E2E 多节点选择器误点与计数范围错误**（fj-as-controls-polish-dfcc）→ `resolved`。症状：点击后目标日志未展开，刷新后全页事件数不等于单节点 5 条。可证伪假设：线性会话的四个节点同时挂载，通用 selector 落到视口外首节点并把四份列表一起计数。改为 nodeId 限定、点击前 scrollIntoView、节点内统计，统一前缀 `sh scripts/mobile-verify/mobile-as-adopt.sh` 完整 exit 0。初轮 exit 1 与诊断轮主动终止 exit 143 日志保留在契约 out/mobile-as-adopt-first.log、mobile-as-adopt-diagnostic.log；最终证据 mobile-as-adopt.log。

||||||| 0f126ab
- **AS shadow 全部断言通过后验证锁目录已消失**（fj-sidebar-wave2-c6c6 补充复验）→ `not-reproducible`。症状：功能断言全部 PASS，清理 `rmdir /tmp/trellis-mobile-verify.lock` 报不存在导致 exit 1。可证伪假设：共享锁被其它清理动作提前移除，具体进程未定位；同代码单独复跑退出 0，未修改清理脚本掩盖错误。判定命令：统一隔离前缀运行 `sh scripts/mobile-verify/mobile-as-shadow.sh`。失败证据 `mobile-as-shadow-cleanup-attempt1.log`、复跑 `mobile-as-shadow.log` 均在契约 out。

- **稍后再读脚本在长问题的回答懒挂载前等待按钮**（fj-sidebar-wave2-c6c6）→ `resolved`。症状：真库随机选中的节点有完整回答，但 `response-more` 等待超时。可证伪假设：长问题把回答推离视口，`ResponseBody` 的 `useNearViewport` 只挂纯文本占位。脚本在每次打开会话后先滚到回答；日志记录滚动前位置，原书签、跨设备同步及分页断言全部通过。判定命令：统一隔离前缀运行 `sh scripts/mobile-verify/mobile-read-later.sh`，exit 0。首次失败及最终日志在契约 out 的 `mobile-read-later-attempt1.log` / `mobile-read-later.log`；产品代码未改。

- **波 2 手机断言仍依赖已退役链行 / 将 checkbox 视为文本输入**（fj-sidebar-wave2-c6c6）→ `resolved`。症状：touch-targets 找不到 `session-chain-row`；safe-area 将归档 checkbox 的 11px 字号判作文本输入失败。可证伪假设：测试范围滞后于新工具条。链行断言迁到排布 / 来源 / 归档触控目标；字体检查排除非文本 input，与既有 `mobile-input-font-scan.ts` 同口径，文本及 select 的 16px 守卫保留。判定命令：统一隔离前缀分别运行 `sh scripts/mobile-verify/mobile-touch-targets.sh`、`sh scripts/mobile-verify/mobile-safe-area.sh`，最终均 exit 0；首次日志保留在契约 out。

- **波 2 手机导航脚本沿用顶端链行点击**（fj-sidebar-wave2-c6c6）→ `resolved`。症状：切到统一项目列表后跨会话恢复等待超时；可证伪假设：目标会话在抽屉下方，旧自动点击未先滚动。CDP 实测目标行 top=4218px、URL 未切换；补 `scrollIntoView` 和视口断言后，真实点击恢复保存的 node/view，完整脚本通过。判定命令：`env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db sh scripts/mobile-verify/mobile-branch-chain.sh`。首次失败还受额外浏览器诊断干扰；两次尝试日志保留在契约 out。

- **AS project 全库 thread reuse 断言包含无关线程**（fj-as-adopt-a06a）→ `resolved`。生产快照已有其他 AS 线程，副本全库 COUNT=2、fixture 会话 COUNT=1；审批/撤卡/三轮共用 engine 均 PASS。按最新主控裁定将 COUNT 限定为 fixture 的 session_id，保留原始生产快照，不再清理旧绑定；统一前缀下 `sh scripts/mobile-verify/mobile-as-project.sh` 完整 exit 0。修改只影响此断言统计范围，独立的三轮共用 engine 检查及重试/分叉断言不变。最终证据 out/ruling-mobile-as-project.log、ruling-as-project-counts.txt；曾恢复全库断言及使用临时库清理的历史证据仍保留，但不作为最终版本。

- **统一验证前缀下的既有 fixture 假设**（fj-as-adopt-a06a）→ `resolved`（Herdr/followup）。Herdr fixture 被继承的 TRELLIS_HERDR=off 禁用；followup 桌面输入框先于 Markdown 段落就绪。只在隔离 Herdr socket 的子进程显式 on、等待目标段落。判定命令：统一前缀下的 `mobile-herdr.sh`、`mobile-followup-approval.sh`，均复跑 exit 0；日志在契约 out/。AS project COUNT 问题与最终裁定另列上条，历史记录保留。

- **N1 已知非 git workspace 更新触发快照风暴**（fj-hb-nest-fix2-238c）→ `resolved`。症状：每条省略 worktree key 的 workspace_updated 都重拉快照；可证伪假设：缺 key 被误判为未知元数据。改为本地未知 ID 或显式元数据变化才拉取。判定命令：`bun test lib/server/herdr-client.test.ts -t N1`，两条回归在旧实现失败、修后通过；三类 workspace 事件各十次无额外快照，新增/元数据变化仍拉取。全量验证 218 pass。

- **排序 E2E 未结束旧等待卡片**（fj-hb-nest-fix-115b）→ `resolved`。症状：状态对调断言等待；假设：普通 PreToolUse 按既有规则保留 AskUserQuestion。改用匹配的 PostToolUse 结束卡片；判定命令：`env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-herdr.sh </dev/null`。首次尝试主动终止 exit 143，最终复跑证据见契约 out。

- **Herdr 分支缓存测试时钟撞名**（fj-hb-nest-fix-115b）→ `resolved`。症状：单次测试重复 SQLite Binding 类型错误；假设：函数 `now` 通过 options 扩散至 bindings 数值字段。改名 `branchNow` 后消失；判定命令：`bun test lib/server/herdr-fleet.test.ts && bunx tsc --noEmit`，11 pass / exit 0。

- **D4 独占运行仍在 N9 底部点击处失败** → `resolved`（fj-trellis-step2c-31e1 返验）：启动前无 mobile 进程、锁与测试端口，排除本轮资源竞争。审批移除使内容缩短，scrollTop 被浏览器夹到新底部；旧 onScroll 将位置下降当成用户上滑。保留真实上滑停止逻辑，仅排除夹到新底部的布局移动，增加 600px 内容移除的浏览器反例。判定命令：原 `env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-as-shadow.sh </dev/null` 修前 exit 1、修后 exit 0，原 N9 与 4px 上滑断言全部保留。日志在契约 out/d4-exclusive-reverify.log、d4-layout-fix.log。

- **分叉继承工具仍显示 running** → `resolved`（fj-trellis-step2c-31e1）：上游将 live item 标成 failed，但保留缺失的 completedAtMs；假设 Trellis 用时间戳而非 status 判断运行态。改为协议 status 优先，保留旧无 status 快照兼容；判定命令 `bun test lib/server/as-client.test.ts -t 'live fork'` exit 0，真实 mock daemon 分叉快照映射为 error，完成时间仍为 null。

- **AS 重试清空旧答案、非 tip 普通续聊失败、AS=off 对已绑定会话失效** → `resolved`（fj-trellis-step2-fix-683f）：原 reset 在启动前执行，非 tip 被误归类为显式 fork，切流只查 DB 绑定。修为成功后切换重试版本、普通历史提问播种新线程、统一硬关闸回退；并清理 fallback 孤儿映射、共享并发初始化、中断免租约。判定命令：`bun test lib/server/as-project.test.ts lib/server/session-binding.test.ts` 与原 env -i `mobile-as-project.sh`；最终完整 bun test 124 pass，D3/D4 exit 0。

- **验收侧 D4 env -i 非零退出** → `not-reproducible`：假设 project/shadow 并跑造成锁/端口竞争，实查启动前没有脚本、锁和测试端口监听，故不能归因竞争。首轮在额外 browser 诊断后出现 about:blank、N9 超时，证据受干扰；不干预浏览器的两次独占复跑均通过全部用例。判定命令：`sh -c 'env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-as-shadow.sh </dev/null'` 连续 exit 0；未改代码或删除用例。日志在契约 out/shadow-reverify2.log、shadow-reverify3.log。原验收失败根因仍未确认。

- **AS project 任意节点分叉阻塞验收** → 验收阻塞 `resolved`，协议缺口仍在上游 backlog：7913839 对 fromItemId 返回 -32008。主控裁决只验 tip 成功与早期节点明确拒绝，客户端不伪造历史分叉。判定命令：`env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-as-project.sh` exit 0；旧节点数据及 thread 绑定不变。任意节点分叉仍依赖上游 prefix/fromItemId 实现。
- **AS 长链页面导航挂起** → `resolved`：假设同 thread 的多个节点独立 EventSource 占满浏览器连接；改为按 thread 共享订阅，最后一个控件卸载后关闭。判定命令：`env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-as-project.sh`；完整复跑 exit 0，早期节点错误页面导航与截图成功。

- **AS 审批撤卡后处理者提示可能缺失** → `resolved`：决定可能发生在元数据 GET 与 EventSource attach 之间；将处理者记录写入 as_turns.resolved_json，并在节点结束时重读补发；按 requestId 限定提示，避免串到同 thread 的其他节点。判定命令：`env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-as-project.sh`；最新实测双向竞答提示通过（最终仍因独立的分叉阻塞 exit 1）。
- **主目录 `next dev` 起的实例前端永远停在「加载中…」，React 从不 hydrate**（S75 发现，S97 破案修复）→ `resolved`。**起作用的是**：`next.config.ts` 给 `allowedDevOrigins` 常驻加 `"127.0.0.1"`。根因链（三环，缺一不发病）：① 用 `http://127.0.0.1:<port>`（而非 localhost）访问 dev → ② Next 16 dev 的跨源防护只认启动 hostname，把带 `Origin: http://127.0.0.1` 的 **HMR WebSocket 握手静默掐断**——不回 HTTP 响应、server 不打日志、浏览器只见 1006（内部为 `net::ERR_INVALID_HTTP_RESPONSE`）→ ③ Next 16.2 dev 把 RSC/hydration 的 promise 与这条 WS 绑死（`app-index.js` 的 `await initialServerResponse` 永不 resolve，上游 vercel/next.js#91770），hydrateRoot 永不执行。于是 SSR HTML 完好、chunk 全 200、React runtime 全加载、flight 数据全消费、console 零报错——只差最后一步 commit。**S75 的 CSS parse 假设证伪**：注释掉 `::highlight(branch-source)` 后 parse error 清零、hydration 照挂（该规则无辜，已还原）。沿路另证伪：Cache-Control headers、bun vs node、Turbopack vs webpack、16.2.4 vs 16.2.6、浏览器扩展、shell/系统代理、headless vs headed——**极简两文件 repro 全部复现**，坐实与 trellis 代码无关。**判法（复发一条命令定性）**：`curl -H "Origin: http://127.0.0.1:<port>" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: x" -H "Sec-WebSocket-Version: 13" http://127.0.0.1:<port>/_next/webpack-hmr` 空响应 = 中招；换 `Origin: http://localhost:<port>` 得 101 = 同一根因。修后验证：127.0.0.1 访问 dev login，fiber 0→26、口令输入后按钮解禁。**方法论**：破案靠"从 hydrate() 源码找第一个 await → patch WebSocket 构造器观测 → Playwright 抓真实 net error → curl 复刻浏览器握手头二分"，前七个假设全是环境猜测、全灭；**对"静默无报错"故障，观测点要打在框架内部的等待链上，不是环境上**。

- **prod（launchd）spawn 出来的 claude 一律认证失败：`Failed to authenticate: OAuth session expired and could not be refreshed`**（S90 发现，S93 破案修复）→ `resolved`。**起作用的是**：`security delete-generic-password -s "Claude Code-credentials"` 删掉 Keychain 里 7-26 停更的死凭证副本（refresh token 被文件侧单次轮换作废后永久判死；launchd 上下文的 claude 读 keychain、终端读 `~/.claude/.credentials.json`，所以终端永远复现不出来——S90 五条排除全扑空的原因）。修后验证三级全绿：一次性 launchd job 裸跑 `claude -p`（修前 80ms 本地判死 `api_ms:0`，修后真调 API 返 "ok"）→ 真 prod 任务 run `45350b21` done/6 token。**方法论**：怀疑 launchd 特有故障时，判定必须用一次性 launchd job（`launchctl bootstrap gui/$(id -u) <plist>`），`env -i` 复制得了 env、复制不了「不是 launchd」。复发哨兵：keychain 条目重新出现且 mdat 冻结。机器级事实在 workspace.md 凭证表 + 复发坑表。
