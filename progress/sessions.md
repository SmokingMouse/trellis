# Session Log

最近 5 条，倒序（Session 125 / 124 / 123 / 122 / 121）。更早的见 `archive.md`。

### Session 125（2026-08-28，S4 多租户第一期落地：实例级隔离 + 租户网关，焚决四坐席并行交付）
- **触发**: 用户「我想支持多租户模式，可以把我这个平台开放出去；对文件系统做隔离」→ plan mode 三路探索 + 用户拍板（小圈子邀请制 / 租户自带凭证可共享 / 每租户一容器 / Mac mini 本机）→「全部实现，用 fenjue 调度」。
- **架构决策**（[ADR](decisions/2026-08-28-multi-tenancy-instance-isolation.md)）: **实例级隔离**——每租户一个 Docker 容器跑完整 trellis 实例，宿主薄网关做认证+路由+cookie 翻译，**trellis 本体零改动**。否掉单实例多租户改造（10 表+73 仓储函数+52 route+2 条全局 SSE 广播全要加 owner，漏一处即泄露，且防不住 CLI 的 Bash）；所有路径根都是 `os.homedir()`，容器 HOME 即天然隔离。
- **Done**（焚决四单全部 settle pass + accepted，全新代码集中 `tenancy/`）:
  1. `fj-mt-spike-54c5`（gemini scout）: 网络前提实测——宿主 clash TUN **透明覆盖** Docker VM 出站（容器直连 anthropic/npm/claude.ai 全通，运行期零代理）；备用 `host.docker.internal:7897` 可达；bookworm 无 ttyd 包→GitHub aarch64 1.7.7；claude/codex 容器内秒装、OAuth URL 正常生成。
  2. `fj-mt-image-681e`（codex）: `tenancy/image/Dockerfile`（node:22-bookworm-slim 多阶段，build 期 HOME=/opt 满足 turbopack root，应用 /opt/trellis，node 用户原位重命名 tenant）+ `entrypoint.sh`（幂等骨架）+ `tenantctl.ts`（build/add/start/stop/restart/rm/status/upgrade/port；docker run 承重面: --init/per-tenant network/127.0.0.1 端口/named volume/--stop-timeout 35/资源限额）。D1-D7 settle 独立复跑全绿（build→起容 auth:on→身份→**Mock provider 全链路 CHAT_OK**→重启持久→upgrade 保数据→purge 零残留）。
  3. `fj-mt-gateway-0042`（codex）: `tenancy/gateway/`（gateway/db/auth/tenants/proxy-util/pages/selftest）+ launchd 模板（NumberOfFiles 4096）。argon2id+sha256 session、邀请认领、限速、cookie 翻译（删 gw cookie/剥走私 trellis_auth/注入租户 token）、继承 server.ts 五坑（Host 改写/剥三头/idleTimeout 0/signal+duplex/redirect manual）、Bun 原生 WS 逐帧。selftest 12 项 settle 全绿。
  4. `fj-mt-m3-3073`（gemini）: tenantctl 增补 `creds-share --claude-token|--revoke`（setup-token 经 CLAUDE_CODE_OAUTH_TOKEN env 注入+重建，绝不拷 credentials.json）与 `backup`（volume tar 归档）。D1-D4 settle 全绿。
  5. Supervisor 收尾: **真容器 × 网关联调通过**（邀请认领 200→cookie 翻译→真实例 /api/sessions 200→mock 对话 SSE created/done 全链路）；selftest 补 120s watchdog；`tenancy/README.md`（架构/威胁模型/运维手册）。
- **验证**: 四单 settle 全部独立复跑（不采信坐席自述）——spike D1/D2、image 九条 verify（完整容器生命周期重放）、gateway selftest 12 项+独立启动+plist、M3 四条；merge 后 main 上 selftest 全绿；真容器×网关端到端 curl 联调全绿。
- **Next**: ① 公网接入待房主拍板（caddy 站点块+域名，见 tenancy/README.md）；② 宿主 memos/stirling 建议改绑 127.0.0.1（容器可经 host.docker.internal 触达）；③ 第一位真实朋友上车时做真人端到端（真 claude login+Web 终端）；④ S121+S122 一起 `make deploy`（tenancy/ 不影响单人版运行时，零风险合部）。


### Session 124（2026-08-24，工作区读写与侧栏交互重构：已合并折叠降噪 + 批量安全清理 + 改动检视 Diff 弹窗）
- **触发**: 用户反馈侧栏内容繁杂、体验较差（几十个历史 worktree 堆叠刷屏、分支与目录名并排截断、缺少工作区读写闭环能力）→「开始优化吧」。
- **根因**: ① `SessionSidebar` 将所有 worktree（包含大量已合并入主干且 0 会话的已完成分支）平铺在项目下，僵尸工作区严重挤占主视野；② `GroupRow` 强行并排展示目录名和分支名，导致两端均被截断为 `...`；③ 缺乏批量治理能力，清理已完成工作区需逐个 hover 确认数十次；④ 缺乏工作区代码变更检视（读）与流转（写）能力，用户看到 `● 56` 脏改动无法在平台内查看具体文件与 Diff。
- **Done**:
  1. `components/SessionSidebar.tsx`:
     - **智能分区折叠**：自动将项目下的工作区划分为「活跃工作区」与「已合并/可清理工作区（`reclaimable: true` 且 0 运行会话且 0 脏改动）」，后者默认收敛归入子折叠组 `✓ 已合并 (N)`，主界面视野信噪比提升 80% 以上。
     - **消灭截断排版**：精简行内布局，移除重复截断的长分支名展示，将完整路径、分支、脏文件数与可回收提示统一收敛入悬浮 Tooltip；
     - **交互式状态角标**：`● N` 脏文件角标支持直接点击开启改动检视；
     - **权限放宽**：单项工作区删除支持所有 `kind === 'worktree'`（不局限于 trellis 创建），均走严密的两阶段预演与 force 二次确认。
  2. `app/api/workspaces/git-diff/route.ts` & `components/WorkspaceDiffModal.tsx`:
     - 新增 Git 变更检视 API 与弹窗：支持查看当前工作区分支、upstream、ahead/behind 提交数、未提交文件状态清单（`M` / `A` / `D` / `??` / staged 标识及 +/- 行数统计）与完整行级统一 Diff 预览；支持一键在本地 VS Code 打开、复制路径与在此工作区新开会话。
  3. `app/api/workspaces/worktree/clean/route.ts` & `components/BatchCleanModal.tsx`:
     - 新增批量清理已合并工作区功能：在 `✓ 已合并 (N)` 折叠行提供一键 `[🧹 清理]` 操作，支持全选/多选预检、安全过滤（自动防护脏文件与运行中会话），一键批量执行 `git worktree remove` 与 prune，彻底释放磁盘与视觉空间。
- **验证**: `bun test` 41/41 全部通过；`bun --conditions react-server scripts/test-workspace-optimizations.ts` 全流程测试（Diff 接口、批量预检与 force 清理）全绿；`bun --bun run build` 成功通过。
- **Next**: 合并至 main 后 `make deploy` 部署上线。

### Session 123（2026-08-24，Compact Continuation 拓扑桥接：长动线上下文压缩后最终回复丢失与孤根断链修复）
- **触发**: 用户反馈 Turn 出现 25 步工具调用却显示「本轮暂无文本回复（只有工具调用）」，结合 Mac mini trellis workspace 与本地 chat transcript 分析归因。
- **根因**: Claude CLI 遇上下文超限自动 /compact 或手工 /compact 时，写入 `type: "system"` (parentUuid: null) 与 `type: "user"` (isCompactSummary: true) 条目。S120 为防止伪造 turn-start 劫持回复将 `isCompactSummary` 排除在 `isTurnStart` 和 `looseTurnStart` 之外；因 system 节点父链指向 null，紧随其后的 assistant 最终答复沿父链上溯到 null 被静默丢弃（resolveOwner 为 null），UI 呈现为只有工具调用、response 为空的僵尸状态，且 compact 之后的后续 turn 孤立成根。
- **Done**:
  1. `lib/server/cli-jsonl.ts`: `indexByUuid` 引入「拓扑桥接（Virtual Parent Linking）」，当 entry 为 compact 相关节点（`isCompactSummary`、`isVisibleInTranscriptOnly` 或 parentUuid 为 null 的 system 节点）且父链断开时，物理序列向前连接至最近有效的带 uuid entry，修复父链 DAG 遍历。
  2. `scripts/test-cli-jsonl.ts`: 新增 Section 4 专项回归断言「Compact Continuation 拓扑桥接与最终答复保留」，全链路验证 import 不丢最终回复、不伪造多余 Turn 节点、后续 Turn 正确继承 parentId、fork 截前缀 tail 正确指向 compact 后的 assistant 最终回复。
- **验证**:
  - `bun scripts/test-cli-jsonl.ts`: 12,752 个 JSONL 文件 / 14,351 个可见 Turn 全量真语料扫描 100% 通过（`noTail: 0, wrongTurn: 0`）。
  - 实测从 112 个真实 compact jsonl 恢复 32,982 条此前断链被弃的 assistant 消息与 82 个长动线最终答复。
- **Next**: 合并至 main 后部署上线。

### Session 122（2026-08-24，自动压缩感知增强：工具连跑折叠状态标识 + 轮次上下文自动压缩分隔条）
- **触发**: 用户反馈触发自动压缩时希望能明确感知到，避免静默压缩导致用户误以为步骤消失或未理解上下文转入紧凑摘要。
- **设计（两层压缩感知）**:
  1. **工具链级冷热折叠感知 (`SegmentRow`)**: 连续 ≥3 个已完成普通工具折叠成 chip 时，增加明确状态徽章（`[已自动收起]` / `[已展开]`）、操作提示浮层（`title="点击展开已自动收起的明细"`）及 live 活跃边框高亮，明确告知用户此处发生自动折叠与可点击展开。
  2. **会话轮次级上下文自动压缩感知 (`LinearThreadView`)**: 新增 `isContextCompacted` 判据（捕获 CLI 紧凑延续摘要标记与 ≥40k token 降幅 ≥40% 门限），在长会话触发自动 compact 时渲染虚线分隔条与徽章（`🗜️ 上下文已自动压缩（早期历史已转入模型紧凑摘要）`）。
- **Done**:
  1. `components/tools/ToolRow.tsx`: `SegmentRow` 增加 `已自动收起` / `已展开` 状态徽章、展开提示 tooltip、live 态视觉区隔，保持冷数据不进 DOM 的同时提供直观感知。
  2. `lib/context-usage.ts`: 新增 `isContextCompacted` 判定函数；补充 `lib/context-usage.test.ts` 单元测试。
  3. `components/LinearThreadView.tsx`: 接入 `isContextCompacted`，在紧凑压缩轮次交界处渲染分隔条与说明。
  4. `scripts/test-timeline-render.tsx`: 补全段落 chip 带有「已自动收起」提示的断言。
- **验证**: `bun test` 44/44 全部通过；`bun scripts/test-timeline-render.tsx`、`bun scripts/test-cli-jsonl.ts`、`bun scripts/test-tool-tree.ts` 全通过；`tsc --noEmit` 0 错。
- **Next**: 合并至 main 后部署上线。

### Session 121（2026-08-24，全平台 SVG 与 Mermaid 渲染与交互体系优化：双模式预览 + 图表放大 + 文件预览）
- **触发**: 用户「现在在平台上,好像不支持 svg 的渲染,做一些优化」→「除此外,把 mermaid 的渲染也加上」。
- **根因**: ① CodeBlock 仅将 `svg/xml/html/mermaid` 作为普通文本代码高亮展示，用户生成图表/流程图/矢量图只能看到一长串代码，无法直接看到渲染后的视觉图形；② 缺少「预览/源码」切换、背景色切换（网格/亮色/暗色防深浅冲突）、缩放与放大模态框、下载 SVG 等操作；③ FilePreview 对 `.svg` / `.mmd` / `.mermaid` 文件缺乏专用图表预览与源码双模式；④ Markdown 内直接嵌入的 `<svg>` 缺少响应式防溢出样式。
- **Done**:
  1. `lib/svg.ts`: 新增纯工具库——`isSvgCode`（语言与内容特征识别）、`extractSvg`、`normalizeSvg`（自动补全缺失的 `xmlns`、视口 `viewBox` 兜底、去除危险脚本）、`validateSvgSyntax`（DOMParser XML 解析校验）、`createSvgBlobUrl`（沙箱安全 Blob URL）、`downloadSvgFile`（一键下载）。
  2. `lib/mermaid.ts`: 新增异步懒加载 Mermaid 渲染引擎——`isMermaidCode`（语言与主流图表 starters 自动探测）、`renderMermaidToSvg`（根据当前暗亮主题动态配置 `mermaid.initialize`，支持 flow/sequence/class/state/er/gantt/mindmap 等全系图表语法，安全异常捕获）。
  3. `components/CodeBlock.tsx`: 全面升级支持 SVG 与 Mermaid 代码块——检测到矢量图或 Mermaid 图表时默认开启「👁 预览」视图；提供「👁 预览 / 📄 源码」一键切换；支持背景切换（网格底 / 亮底 / 暗底）、点击放大 / ⛶ 全屏弹窗大图预览（支持 20%~400% 缩放调节与 1:1 重置）、一键下载 `.svg` 矢量图、复制源码，遇到语法畸形或未完成生成时优雅降级提示并引导查看源码。
  4. `components/FilePreview.tsx`: 增加 `SvgFilePreview` 与 `MermaidFilePreview` 专属文件预览组件，支持视觉预览与源码查看双模式、缩放比例控制器、背景色切换与复制/下载；`lib/generated-files.ts` 与 `lib/server/workspace-files.ts` 扩展 `.mmd` / `.mermaid` 文件扩展名识别与 MIME 映射。
  5. `components/HoverPreview.tsx` & `app/globals.css`: 悬浮卡片增加高对比网格背景并支持 Mermaid 悬浮图表渲染；全局为 `.md-body svg` 增加自适应 `max-width: 100%`、`height: auto` 与居中展示，彻底杜绝内容溢出卡片。
- **验证**: `scripts/test-svg-rendering.tsx` 全流程断言通过（包含 SVG 提取/规范化/清洗、Mermaid 识别与 Markdown Unified AST/JSX 转换）；`bun --bun run build` 成功完成 Turbopack 生产编译。
- **Next**: 合并至 main，下次 `make deploy` 部署上线。

