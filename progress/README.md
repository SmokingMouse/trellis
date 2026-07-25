# Trellis Progress

## Current Focus
**外部 PR 清仓：#10 IME 回车守卫 + #11 画布 peek 原地展开（Session 72，已 merge 推送 GitHub）**：Aaron 两个 open PR 审毕合入。① **#10**：BranchPopover textarea 的 Enter 判定前加 IME 组合守卫（`isComposing || keyCode===229` 直接 return）——中文输入法给英文串上屏的回车不再误触发分叉提交；单文件 5 行，主 composer 走 ⌘Enter 本就不受影响。② **#11**：画布 compact 小卡加「展开预览」按钮 → 该卡就地渲染成 600px 完整卡（`PEEK_CARD_HEIGHT=480` 固定高、body flex-fill 内滚），`layoutNodes` 加 `forceFullIds` 按确定宽高预留 footprint，dagre 单趟让开兄弟/顶开后代；可多卡同开、「收起」折回；选区 popover 加 rendersFull 门控（收起后关闭滞留按钮，expanded 态 sticky 不丢输入）。**审查要点已核**：`data-chat-node-id` 只在 ChatNode/TurnCard 上且 Canvas 与 LinearThreadView 互斥挂载——popover 新门控不影响线性视图、reference 卡本就无选区路径。验证：两 PR 合并树 tsc ✓、lint 零新增（Canvas 2 项 setState-in-effect 为 main 基线既有）、隔离 worktree build ✓、隔离实例（:3163 独立 DB + mock provider）浏览器实测——两节点树点「展开预览」：完整卡原地出现（600×480 z=1000）、子节点 y=556 让位无重叠、不跳线性；「收起」后子节点回位 y=166 ✓。**注意**：本地 main 领先 origin 3 个 commit（S71 的 npm 化三连）仍不能 push——`@smokingmouse/agent`/`llm` npm 404 未发布，push 闸依然是用户 `npm login`；已把远端 PR merge rebase 到本地 3 commit 之下，合并树 tsc ✓。**Next**：用户 npm login → publish → 两仓 push（S71 流程不变）；PR 功能上 prod 需 build + kickstart。
**追记（同日，publish 闸全通 + prod 上线 + 两仓 push）**：用户配好 npm 凭证（2FA/granular token）后全链跑完。① `@smokingmouse/llm@0.3.0` + `agent@0.3.0` publish 成功（`--access public`；pack 清单复核仍只有 dist+LICENSE+README+example yaml）；新包 registry 传播延迟 1-4 分钟，agent 比 llm 慢。② 本机 `.npmrc` 默认源是 npmmirror（镜像未同步会 404）——加 `@smokingmouse:registry=https://registry.npmjs.org/` scope 钉源（@anthropic-ai 同款）+ 触发 npmmirror 主动 sync。③ 干净 worktree 全新 `bun install` 从 registry 拉 700 包 ✓ + tsc ✓ + build ✓ = 部署故事闭环。④ 主目录 `make unlink-sdk` 回 registry 版（此前是 link-sdk symlink），bun.lock 锁定 registry 0.3.0（补 S71 遗留，单独 commit）；`make build` + launchd kickstart，prod 验活 login 200 → authed 200 → `/api/providers` 正常出全 provider 清单。⑤ **sdk 仓推送有插曲**：发现 publish 时 src 里有两处未提交改动（`EventType.Task` 子 agent 生命周期事件 + `ToolCall.parentToolUseId`，Stage 22 地基）已被编译进发布的 0.3.0——补 commit 对齐 git 与 npm 产物；远端 main 另有 ~90 个 harbor 演进 commit，rebase 撞 sequencer 卡死（index 干净仍报冲突）改走 merge：冲突全是 scope 改名 vs harbor 新版，取远端 + 机械重放改名（含远端新增 4 个 test 文件），claude.ts 两侧追加 helper 并存；全仓 tsc + harbor tsc ✓ 后推送 `754d6f1`。trellis 亦已 push。**S71 的 npm 化目标就此全部闭环。**

---
**npm 化部署 + 应用内模型配置（Session 71，已 commit `8816dae`+`dbb7c41`，publish 阻塞在 npm login）**：部署去摩擦两连。① **依赖 npm 化**：`@sm/*` file: 绝对路径依赖 → `@smokingmouse/agent`+`@smokingmouse/llm` `^0.3.0`（~/sdk 已备好 0.3.0 + MIT + 泄露闸全验——npm pack 真打包清单只有 dist+LICENSE+README，无 key/个人路径/apps；npm org `sm` 被占故换 scope，改名波及两仓全部 import）；Makefile 引导链（setup/sdk-build/patch-deps/relink-sdk）退役成 `bun install`，新增 `link-sdk`/`unlink-sdk` 本地改 SDK 用；README Quickstart 重写。endpoints.yaml 搜索序变 `$SM_ENDPOINTS_PATH` → `~/.config/sm/endpoints.yaml` → legacy `~/.claude/global/`（本机零迁移）。`/api/providers` 优雅降级：yaml 缺失或 yaml 无 native provider 时原生 Opus/Sonnet/Haiku 恒在（新手裸 claude 登录全功能，不再 500）。② **模型配置 UI**：ModelPicker 尾行「⚙ 管理模型…」→ ModelConfigModal（provider 增改删表单）；服务端 `lib/server/model-config.ts` 用 yaml Document API 编辑（保留手写注释），key 只进 env_file（`~/.config/sm/.env` 0600）+ process.env 永不回显，保存 `clearEndpointsCache()`（@smokingmouse/llm 0.3.0 新导出）热生效。tsc ✓ lint 零新增 ✓ 隔离 worktree build ✓ + 隔离实例(:3162, SM_ENDPOINTS_PATH+TRELLIS_DB_PATH 沙箱)实测：API 八项（fallback/创建/key 写入+0600/注释保留/脱敏 grep 零命中/热刷新/校验报错/删除）+ 浏览器全链路（登录→picker→管理模型→添加 uiprov+key→列表 ✓key已配→picker 无刷新出现 uiprov·ui-model-1/2 且原生档共存）全绿。**踩点三个**：(a) Header `backdrop-blur` 劫持 fixed 后代 containing block——Modal 从 picker 内打开必须 createPortal 挂 body（SketchModal 同款）；(b) 伪 HOME 隔离与 turbopack root/共享 node_modules symlink 冲突（"points out of the filesystem root"）——改用真 HOME + `SM_ENDPOINTS_PATH`/`TRELLIS_DB_PATH` env 隔离；(c) agent-browser `click @ref` 对 popover footer 按钮失效（popover 关但 onClick 不触发；同 popover 模型行正常）——裸坐标 mouse down/up 与程序化 .click() 都正常 = playwright actionability 环境怪癖非产品 bug（S70 Excalidraw 同类）。**Next**：用户 `npm login`（npmjs.com 账号名需 `smokingmouse`）→ publish llm+agent → trellis 全新 bun install 从 registry 实测 → make build + kickstart prod 验活 → 两仓 push。

---
**画板草图输入（Session 70，已提交推送，免签待补）**：用户要求「加画板，快速画草图让 AI get 我的意思」。选型用户拍板嵌 **@excalidraw/excalidraw@0.18.1**（peer react ^19 ✓，形状/箭头/文字全能力），导出 PNG 灌进 Stage 15 vision 附件链路，**服务端零改动**。落地：① `components/SketchModal.tsx`——`dynamic(ssr:false)` 按需加载（数 MB chunk 首开才拉），FilePreview 式 portal 近全屏，顶栏「插入草图」= `exportToBlob`（appState 强制 exportBackground + 亮色导出——给模型看的图不受 UI 主题影响）→ `onExport(blob)`；空场景按钮禁用、非空 ✕ 先 confirm、theme 跟随 `.dark`、langCode zh-CN、UIOptions 砍掉 loadScene/saveToActiveFile/export 误导项；② 入口 ✏️ 双接线：Composer（📎 旁同款按钮）+ QuestionInput 首屏（「草图」）→ `att.startUpload(blob, "sketch.png")`，上传/预览/发送/vision 全免费继承（BranchPopover v1 不加）；③ 键盘让位：`isEditableTarget` 加 `[data-keys-yield]` 让位区（Excalidraw r/o/a/t/Esc 整套键盘交互 vs app J/K/B/F/Esc×2 冲突——尤其画画时 Esc 取消选择绝不能误触中止生成），`useEscapeAbort` 手写 guard 顺势收敛进共享函数。tsc ✓ lint ✓ + 隔离 worktree build ✓（主目录 `.next` 未动，prod 不受影响）+ 隔离实例（:3161 独立 DB）实测：挂载中文 UI/暗色跟随 ✓、空场景禁用→画矩形激活 ✓、插入→附件缩略图（白底 PNG 220×116）✓、**真 claude opus 发送→答「这张图片画的是一个圆角矩形」= vision 端到端 ✓**、线性 Composer 入口 ✓、空画布 ✕ 直接关 ✓、字体零 CDN（Turbopack 全打进 `_next`，离线安全，无需 EXCALIDRAW_ASSET_PATH）✓。**踩点两个**：(a) bun 1.3.14 `bun add`/`install` 会把 @sm/agent+llm 的 file: 依赖装坏（ENOENT cache、"Failed to install 2 packages"）——`make relink-sdk` 即修，**任何 bun install 后必跑**（Makefile 本有此机制，这次是它救场）；(b) agent-browser（headless/headed 皆然）驱动 Excalidraw 画布时渲染进程随机暴毙（localStorage 探针证实非导航非 JS error；excalidraw.com 官方站同流程同样崩）——自动化环境问题非集成 bug，人手操作不受影响。**Next**：用户现场验收（真手感：画形状/文字/触摸）；已与 S69 分开摘成两 commit 推送；上 prod 需 build + kickstart。

---
**树面板折叠子树（Session 69，已提交推送 `8376df3`，免签待补）**：用户要求「右侧预览（树面板）里能折叠子树」。方案 = 复用画布/Outline 已有的 store.collapsedNodeIds——「这个子树折起来了」是树的状态而非某个视图的状态，per-session 持久化、新子节点自动展开、跳转自动展开祖先（setActiveNode→expandAncestors）全部免费继承，零新状态。落地：① `lib/tree-panel.ts` `flattenTree` 接受 collapsedIds（折叠节点不下钻），TreeRowItem 增 hasChildren/collapsed/hiddenRollup（被藏后代的 数量/未读/等输入/生成中）；② TreePanel 列表行加折叠箭头（仅有子节点的行，Outline 同款三角 rotate-90，叶子行占位对齐），折叠行回显「+N」+ 未读点数 + 🙋/生成中 rollup（折叠不该把状态一起藏掉，S66 折叠树行同语义）；③ 图形视图刻意不过滤——它是「看形状」的总览面。tsc ✓ lint ✓ + worktree 隔离 build ✓ + 隔离实例（`~/trellis-collapse-tmp` worktree :3160 + mock 7 节点双分叉树）浏览器实测：折叠 #3 行显 +2·未读2 rollup 且 #5/#6 消失 ✓、折叠 #2 显 +5·5 ✓、⌘J 跳进被折叠的 #6 自动展开全部祖先 ✓、画布侧同步（Outline #3 变 ▶（2）、画布 #5/#6 卡片隐藏）✓、reload 折叠保持且 rollup 未读数随已读更新（+2·1）✓、再点展开还原 ✓。**踩点**：隔离实例 worktree 放 /tmp 会触发 Turbopack panic（macOS /tmp 是 symlink，distDirRoot 越界报错）——放 $HOME 下 ASCII 路径即可；Next 16 同目录禁止第二个 dev server，worktree + 共享 node_modules symlink + `bun --bun run dev` 是标准解。**Next**：用户现场验收；已随 S70 一并推送（`8376df3`）；上 prod 需 build + kickstart。

---
**markdown 图片本地路径预览修复（Session 68，emperor worktree，已提交推送，免签待补）**：用户截图报「图没法预览」——答案里 AI 生成的图 `![图](/Users/…/foo.png)` 渲染成破图。根因：S63 链接接管只做了 `a`/`code`，`MD_COMPONENTS` 没有 `img` 渲染器，本地路径 src 被浏览器当 http 路径请求 → 404 破图。落地 `MdImage`（HoverPreview.tsx，全部 8 个 ReactMarkdown 调用点经 MD_COMPONENTS 共享）：① 本地 src（绝对 / file:// / workspace 相对，复用 `previewableHref`）重写走 `/api/files` 会话白名单代理，点击开 FilePreview overlay（cursor-zoom-in + title=路径 + nodrag）；② 远程 URL 原样加载；③ 任何加载失败（白名单外 / 文件不存在 / `~` 路径）降级为「🖼 alt — 无法预览：文件不存在，或不在本会话可预览范围」行内占位（S63 追记同款自解释文案，白名单政策不变），不再露浏览器破图 icon；④ 样式 max-h-[420px] + object-contain + rounded-card 防大图撑爆卡片。tsc ✓ lint 零新增（7 项均基线既有）✓ build ✓ + 隔离实例（:3158/:3159 独立 HOME mock）四形态实测：workspace 绝对路径显示 ✓、file:// 显示 ✓、白名单外降级占位 ✓、远程 URL（icon.svg）原样加载 ✓、点击本地图开 FilePreview overlay ✓、lint 清理后复测两路仍过 ✓。**注**：用户截图会话（#171）不在本机 prod DB——本机各数据源均无该消息，判断来自另一台部署（公司机?），但根因是共享渲染层代码，修复全部署通用。**已上 prod**（2026-07-20）：merge main `1f3b063` + push + 主 repo build + kickstart，authed 200 验活 ✓。**Next**：用户现场验收；公司机部署待自行拉取重启。

---
**节点手动标未读（Session 67，emperor worktree，已提交推送，免签待补）**：用户要求「支持对节点标注未读，卡片和预览树都能操作」。已读机制此前单向（视口停留 1s 自动已读，无手动回退）。落地：① 双入口 toggle——线性视图**卡片头**操作区（⑂ 前，仅 done 节点：已读显「标为未读」实心点 icon / 未读显「标为已读」圆勾 icon）+ **树面板当前树节点行**行尾 hover 按钮（整行 button 改 div.group + 主按钮 + 操作按钮，雪藏按钮同款 pattern；预览卡 pointer-events-none 不承载操作）。② 服务端：repo `markNodeUnread`（read_at 置 NULL）+ `/api/nodes/[id]/read` 加 **DELETE**（POST 标已读的反向资源语义）。③ **关键机制 `unreadHolds`**（store 内存态，不持久化）：手动标未读若卡片仍在视口，1s 后会被 IntersectionObserver 自动标回——hold 挡住 `scheduleRead`（调度点 + timer 回调双检查防 race）；解除时机 = 显式导航到该节点（`setActiveNode`，含树面板跳转）或手动标回已读——邮件语义「瞥见不算读，点开才算」。跨 reload hold 消失属可接受边缘（恢复位置恰停该卡则重新自动已读 = 用户正看着它）。tsc ✓ lint 零新增（5 项均为基线既有）✓ build ✓ + 隔离实例(:3157 mock 5 节点分叉树)实测：API 四项（POST/DELETE 往返 + DB 核实 + 404）✓；浏览器全链路——卡片头标未读→状态点变绿+树面板行未读点同步、**标未读后停留 2.5s 不被回读（hold 生效，卡片/树面板两入口都验）**、树面板行 toggle 双向、点行显式跳转后停留 2.5s 自动已读恢复（hold 解除闭环）、hover 显隐/缩进/链外淡显/active 高亮零回归 ✓。**Next**：用户现场验收（本 worktree 独立 `.next`，未动 prod；上 prod 需 merge main + build + kickstart）。

---
**交互等待三连修：waiting toast + 问答表单补全 + 树面板运行状态（Session 66，已提交推送，免签待补）**：用户两反馈 + 一追加。① **等待交互提醒**——run 暂停在交互式工具时此前毫无提醒（done toast 只管完成）：`doneToasts` 条目加 `kind: "done"|"waiting"`，`interaction_required` 到达且不在焦点（activeNodeId ≠ 该节点，与 done toast 同规）时弹「🙋 等你回答 / 📋 等你批准计划 / 🛡️ 等待工具授权」amber toast（按 pendingInteraction.toolName 分文案），**不自动消失**（run 阻塞在等用户，消失即失联）；resolved / respond 乐观清除 / done / error / retry 五路全部清除 waiting toast。② **AskUserQuestion 表单补全**——补「其他（自定义回答）」选项（工具 schema 官方约定 Other 由 UI 侧提供、模型 options 里永远没有；单选与预设互斥、多选可叠加）+ 问题标题加「（可多选）」提示 + **answers 值修为 string**（原 multi 提交数组；CLI `sdk-tools.d.ts` 钉死 `answers: {[k]: string}`，多选拼 ", "）。用户报「不能多选」实为可供性问题：multi 渲染本就支持，但无提示无自定义入口。③ **树面板运行状态**（追加需求）——`lib/tree-panel.ts` 加 `isWaitingNode`（pendingInteraction ≠ null）+ TreeEntry `hasStreaming/hasWaiting`；节点行 🙋（优先于 streaming 蓝点）、折叠树行加树级 rollup（🙋 > 蓝点 pulse，等输入更紧急）、悬停预览卡「🙋 模型在等你回答」；已完成/未读/error 沿用既有点位。tsc ✓ lint ✓ build ✓ + 隔离实例(:3155 真 claude opus 增强 chat)端到端：AskUserQuestion 两题（单选+multiSelect）→ 表单多选勾选 + 两题「其他」自定义文本 → 提交 → 模型复述「框架：React；特性：SSR、PWA、边缘渲染（Edge SSR）」（多选拼串 + 自定义文本真 CLI 全收到）✓；waiting toast 焦点切走时出现、35s+ 不自动消失、点击跳到该节点并 dismiss ✓；树面板节点行 #3 🙋、新建树切走后原树折叠行 🙋 rollup ✓。**Next**：用户现场验收。
**追记（次日二，图形树回归）**：用户 prod 重启后首见 S65 文字树面板，反馈「没有右侧树形结构了、交互差一点」，确认最想找回的是**图形化的树形状**。落地：TreePanel 当前树节点区加 **列表 ↔ 图形 双视图**（header ⑂/☰ 切换按钮，偏好 `treePanelView` 走 store + localStorage `trellis-tree-panel-view`，sendKey 同款）。图形视图只画**当前树**（全森林点阵正是 S65 退役 minimap 的死因，树级语义仍由文字行承担）：子树过 dagre compact 布局投影进面板宽（272px，高度自适应 ≤300、横向居中防纯链树贴边），点+连线、r=10 透明命中区、点击跳转、悬停复用同一套预览卡（getBoundingClientRect 对 SVG g 通用）、状态着色与列表同语义（等输入 warn pulse/生成中 accent pulse/错误 danger/未读 unread/active 加大+外圈）。tsc ✓ lint ✓ build ✓ + 隔离实例(:3156 mock 5 节点分叉树)实测：切换渲染 5 点 4 线、悬停卡、点 dot 跳 #5+active 外圈跟随、reload 偏好保持、切回列表 ✓。prod 已 kickstart。
**追记（次日，prod「访问不聊了」根因 + 修复）**：S66 测试期间在项目目录跑了两次 `make build`，而 prod launchd（`next start`，同目录同 `.next`）进程还是旧的——运行中换 `.next` 是 Next 不受支持状态，进程内存旧模块 + 磁盘新文件混跑 → 页面能开但交互挂。`launchctl kickstart -k` 重启后正常（顺带 S57-S66 全部功能上 prod）。**教训（硬规则）：在本目录 build 过之后，必须 kickstart prod，否则 prod 必坏**——隔离实例测试用 `next start` 共享 `.next` 的代价。

---
**树面板替换点阵 minimap：冷热排序 + 手动雪藏 + ⌘J 过滤跳转（Session 65，已提交推送，免签待补）**：右下角 `ThreadMinimap`（210×250 点阵）随树增多必然崩坏——小目标、悬停依赖、2D dagre 投影零语义，树多时"知道每棵树干啥/节点信息/跳转"全是 O(n) 探索成本。三轮交互讨论收敛后整体换范式：**文字化 `TreePanel`**（`lib/tree-panel.ts` 纯数据层 + `components/TreePanel.tsx`），ThreadMinimap 退役删除。①树级用文字行（root topicLabel + 节点数 + 未读角标），节点级只展开当前树（Outline 同规缩进：线性平铺、真分叉缩一级）；②**热度排名制**：热度 = 子树 max(createdAt, readAt)（v1 代理，真 lastVisitedAt 被绊到再加），前 5 棵平铺、其余进「更早 · N」折叠组——排名制不用调参、休假回来不会全场皆冷；③**手动雪藏** `nodes.hidden_at`（仅根行有语义，POST `/api/nodes/[id]/hidden` 接受任意节点自动走根）：强制冷藏进常驻「已隐藏 · N」组（未读角标穿透），**写即复活** = repo 层 `createBranchNode`/`resetNodeForRetry` 自动清根 hidden_at + store 乐观镜像（纯浏览/跳转不解除）；④⌘J（查过无冲突）/头部 ⌕ 进过滤模式，↑↓+Enter 会话内节点跳转（含隐藏树，标注所属）；⑤悬停行复用 S61 预览卡（行比 r=3.5 的点好瞄十倍）。切树落点 = 该树 createdAt 最新节点。踩点：行内组件定义会整段 remount（mouseenter 重触发死循环风险）→ 改普通渲染函数。tsc ✓ + lint 新文件零问题 ✓ + `make build` ✓ + 隔离实例(:3153 mock, 8 树 13 节点)全链路实测：API 五项（非根走根/恢复/写即复活/400/404）+ UI 八场景（面板渲染/切树/预览卡/雪藏+热区补位/恢复/⌘J 过滤跳转/跳入隐藏树不解除/发消息自动复活）全绿。
**追记（同 session 二轮，候补三项全清）**：① **lastVisitedAt 真热度**——store 增 `treeVisits`（per-session `{rootId: ts}`，localStorage `trellis-tree-visits:{sid}`，lastViewed 同款），`setActiveNode`/`jumpToParentAtAnchor`/`jumpToNoteSource`/`jumpToSearchHit` 走根打点，load 时载入并按现存根修剪；`buildTreeEntries` 热度并入 visits——重访旧树不长新节点也算「用过」。② **树内冷分支淡显**——树内的「冷」定义为「不在当前链上」（祖先+锚点+首子链，与线性视图展示的 lineage 同规），链外分支行 `text-ink-faint`；无锚点时不淡显。③ **共享数据层**——`nodeSort`/`childrenIndex`/`isUnreadNode` 收敛进 `lib/tree-panel.ts`，LinearThreadView/Outline 删本地重复实现改 import；Outline 根行对 hiddenAt 树加淡显+「已隐藏」tag（画布不过滤——画布是「看全部」的面，只对齐状态语义）。tsc ✓ + build ✓ + 隔离实例(:3154 mock, 7 树)实测：点 #8 锚定后 #10 链外行 class 实measured `text-ink-faint`（#1/#9 链上正常）✓；访问冷组树C→切回树A 后树C 升热区第二、reload 后排序保持（localStorage 生效）✓；画布 Outline 树B 淡显+「已隐藏」tag、画布节点照常 ✓。**Next**：无遗留；用户现场验收。

---
**错误节点降级标识（Session 64，已提交推送 main `efb53a3`，免签待补）**：中途挂掉（API 500/手动停止）的 turn 此前永远顶着红色错误横幅，且画布上 error 节点永不压缩——即使用户已追问「继续」把活续完（partial 工具结果在 lineage jsonl 里，retry/追问都 resume 同 lineage 不丢上下文，S64 对话已核实代码路径），过时红卡仍钉在画布上。落地降级规则：**error 节点一旦有子节点（= 已续跑/绕过）**，① TurnCard/ChatNode 红横幅降级为一行可展开「⚠ 本轮中断 · 后续已继续」备注（新 `components/SupersededErrorNotice.tsx`，错误详情+「重跑本轮」收进 details）；② 画布允许其进 compact 卡（琥珀色状态条 + ⚠ chip 带错误摘要 title）。无子节点的新鲜错误维持红横幅不变。tsc ✓、lint 无新增错误。**Next**：用户现场 #7(error)/#45(续跑子节点) 热更新即验，过验后 commit；候补 idea：错误横幅加「▶ 原地续跑」（retry 变体：发续跑指令而非重发原问题）。

---
**链接悬浮预览 + 本地文件链接接管（Session 63，已提交推送 main，免签待补）**：markdown 答案里的链接此前是裸 `<a>`（本地路径链接点了 404、样式还被 Tailwind preflight 重置成纯文本）。落地：① `MdLink`（`a` 渲染器）——本地文件 href（绝对路径 / `file://` / workspace 相对，含裸相对名）点击改开既有 FilePreview overlay，外链补 `target=_blank`；② 悬浮 ~250ms 出预览卡（`components/HoverPreview.tsx`，portal + fixed 定位、视口越界翻转、滚动即消失、pointer-events-none）——图片直显、md 渲染、文本截头（增量读 6k 字符即断连，大文件不怕）、html/pdf 只给「点击打开」提示、远程图片链接也可悬浮；③ 行内 code 路径按钮同享悬浮卡；④ `MD_URL_TRANSFORM` 放行 `file:` 协议（react-markdown 默认 sanitizer 会把 file:// href 清空——实测踩到），全部 8 个 ReactMarkdown 调用点接线；⑤ 补 `.md-body a` 基础样式。服务端零改动（复用 `/api/files` 会话白名单，白名单外 hover 显示「无法读取文件」）。tsc ✓ + `make build` ✓（唯一 warning 为 main 已有）+ 隔离实例(:3152 mock)浏览器实测 11 场景全过：md/图片/文本/file:///相对链接悬浮卡、越权 404 优雅降级、外链无卡保跳转、远程图片卡、点击开 overlay 不跳转、移开消失、行内 code 悬浮。**追记**：用户遇「预览失败」，归因 = `/api/files` 会话白名单围栏按设计拒绝（最常见：文件只被 Read 过没写过 / chat 模式无 workspace）。用户裁定**不扩白名单**，仅把 hover 卡与 overlay 的 404 文案改为自解释（「文件不存在，或不在本会话可预览范围（workspace + 本会话写过的文件）」）。

---
**线性视图内容列宽度可调（Session 62，已提交推送 main，免签待补）**：用户反馈卡片太窄。原三容器（顶栏/卡片列/Composer）锁死 `max-w-3xl`(768px) → 全局偏好三档：窄 768 / 宽 1024（新默认）/ 超宽 1280，localStorage `trellis-thread-width` 持久化（sendKey 同款模式：`lib/thread-width.ts` + store loader/action），切换控件 = 线性视图顶栏「窄/宽/超宽」分段按钮（移动端隐藏——卡片本就贴满屏宽）。画布 ChatNode 维持 600px（dagre 布局基准）不受影响。**设置页评估不做**：现有偏好各有语境化入口（主题=ThemeMenu popover、发送键=composer footer、宽度=线性顶栏），单独一页反而多一跳；偏好再积累到 5+ 项时再考虑 Header ⚙ popover 归拢。tsc ✓ + `make build` ✓ + 隔离实例(:3151 mock)浏览器实测：三档切换宽度正确（768/1024/1070=viewport 减侧栏后封顶）、三容器对齐、reload 恢复档位。

---
**ThreadMinimap 悬停预览卡（Session 61——原 60 撞号重编，已提交合并推送，免签待补）**：线性视图右下角树缩略图悬停/键盘聚焦节点点位 → 左侧浮出预览卡（#序号 · Turn/Reference + 问题标题 + 回答纯文本摘要，markdown 剥离、代码块/图片丢弃），对齐 ChatGPT 会话 minimap hover 体验；顺带给点位加 r=9 透明命中区（原 r=3.5 难悬停）。tsc ✓ + build ✓ + 隔离实例(:3149 mock)浏览器实测：两点位卡内容各自正确、移开消失、点击导航不受影响。

---
**切 tab 恢复阅读位置 + 长 URL 溢出修复（Session 60，已提交推送 `1d88af7`+`fe13599`，免签待补）**。追加修复：QuestionBlock 缺 `break-words`，URL-encoded 长串无断点横向撑破卡片（隔离实例复现 + 修后量化溢出 -1px ✓）。主功能：线性视图里「浏览 = 滚动」但 activeNodeId 不动，切 tab/刷新回来总落回根节点。落地：① `ViewState` 增 `lastViewed {nodeId, offset}`（视口顶卡片 + 卡内偏移，存进既有 `trellis-view:{sid}`）；② LinearThreadView 滚动 debounce 200ms 记录（store action 带 sessionId 守卫防切换竞态）、session 落地时恢复滚动（restore effect 声明在 anchor-scroll effect 之前，skip flag 防两效果打架；流式 tip 时让位 bottom-lock）；③ store 级 rebase 订阅——同 session 内 activeNodeId 显式变更（画布点卡/分支跳转/搜索命中）把 readingPosition 重置到新锚点，防旧滚动记录压过用户跳转。tsc ✓ + build ✓ + 隔离实例(:3146 mock)浏览器实测四场景全过：滚动到 #4@150px 切 B 回 A 精确恢复（149.75px）/ 跨 reload 恢复 / 画布点 #2 回线性锚定 #2 / 切走切回落 #2（rebase 生效）。

---
**Tab 串台 + 卡片切换滑动两 bug 修复（Session 59，已提交推送 `5784ec8`，免签待补）**：①线性视图切卡由 smooth 滚动改瞬时跳转；②串台四连修——`created` 事件加 session guard（发送后立刻切 tab，外 session 节点不再嫁接进当前视图/抢 activeNodeId，reference created/done/refresh 同规）+ `loadSessionInternal` latest-wins 序号（慢的旧加载不再覆盖新切换）+ `useCliSyncEvents` 改读 `getState()` 现值（stale closure 不再把视图拉回运行中的 attached 会话，SSE 也不随切换重建）+ 加载时流式基线修复（POST reader 存活的节点 response 置空防「DB 快照+bus 全量缓冲」拼接重复；存活 reconnect 句柄拆除重挂拿新 catchup）。tsc ✓ + build ✓ + 隔离实例(:3145 mock)浏览器实测：流中切 B 视图零污染、流中切回 A 无重复。

---
**模式收敛：砍掉 Workspace 档，chat / project 两档（Session 58，已提交推送 `4818681`，免签待补）** → decisions.md 2026-07-16。用量 0（32 原生 session 无一 workspace）+ 语义被增强 chat / project 双向吃掉。全链路清理（Mode 类型/sdk-adapter/route/store/ModePicker/SearchModal/SessionSidebar/ModeBadge/mode-workspace token 全主题/README 两档文档）+ DB 防御性 migrate（workspace→project，幂等）。tsc ✓ + `make build` ✓ + 隔离实例 HTTP e2e ✓（migration 生效 / chat·project 创建 / 老 `mode:"workspace"` 请求安全回落 chat）。

---
**主题系统 + 界面&交互整体优化（Session 57——原 56 与权限确认撞号重编，分支 `trellis-theme` 已 merge main 权限确认后合入）** → ADR [decisions/2026-07-15-theme-system.md](decisions/2026-07-15-theme-system.md)。语义 token 层（双层变量 + `@theme inline`）+ 5 套主题（默认/纸感/终端/莫兰迪/高对比 × 明暗）+ ThemeMenu/`/theme` 命令 + `components/ui/` 九原语 + 40+ 组件全量迁移（原生色族 utility 已禁用作回归护栏）+ 交互修复九项（断点错位 bug/新会话正名/`?` 快捷键面板/Dots 统一/TargetChip 归一/移动端 SessionTabs 隐藏等）。隔离实例全程验证（computed-style 零 diff 断言 + 截图矩阵 + mock 流式回归）✓。**merge 注**：权限确认（04a9c18）的 InteractionForm 权限卡 / ModePicker 新增段为 token 化前写就，随 merge 一并迁移 token（见 S57 log merge 追记）。

---
**权限确认 Permission Gate（Session 56，已提交推送 `04a9c18` + sdk `924444c`，免签待补）** → [spec](permission-gate.md) / decisions.md 2026-07-15。session 级 `require_approval`（创建锁定，仅 claude 系 workspace/project）：spawn 降 `--permission-mode default` + **ask 规则注入**（硬前提：本机全局 allowlist 裸 `Bash` 会让 can_use_tool 永不触发，实测 ask > allow），可变更工具暂停 → 复用 A路② 管道 → TurnCard 权限卡（允许/本轮总是允许/拒绝+理由）。SDK 加 `RunOptions.askTools`（dist 已重建）。验证全绿：协议探针 + HTTP e2e 四场景 + 浏览器实测；tsc/build ✓，prod 已重启。P1（终端逃生舱 tmux+ttyd）等被绊到再做。**注意：本轮与 S54/S55 在同目录并行，working tree 另有 S55 未 commit 的 Composer/QuestionInput/ChatNode 改动，commit 时需分开摘。**

---
**线性视图中间节点分叉（Session 54，已提交推送）**：卡片头 ⑂ 按钮 → reply-to 式 chip 重定向底部 Composer（`streamBranch(节点, q, null)`），补上「线性页面对中间节点自由分叉提问」的缺口（此前只能划线 ⌘K）。隔离实例 mock 全链路浏览器实测 ✓。

---
**工作区文件抽屉（Session 53，已合入 main）**：workspace/project 会话点 Header ModeBadge → 右侧抽屉（移动端底部 sheet）只读浏览 session cwd 目录树，点文件走既有 FilePreview。API 围栏 + UI 全链路隔离实测 ✓；`make build` 因中文 worktree 路径触发 Turbopack panic 无法在 feature worktree 跑（见 Session 53 Verified Fact，与 Session 52 撞的是同一坑），已在 main（ASCII 路径）补跑。

---
**CHAT 模式"假死"修复 = thinking 可视化 + effort env 卫生（Session 52，已合入 main `a29f9b5`）**：claude 思考期 UI 零反馈像卡死（effort=max 时达分钟级）。双修：① SDK（~/sdk @sm/agent）新增 `EventType.Thinking` 透传 `thinking_delta`，trellis 全链路接力（StreamEvent/RunEvent/catchup → stream-bus thinkingChannel → TurnCard 思考面板 + 画布 ChatNode 指示器）；② `instrumentation.ts` 启动 scrub 从 shell 继承的 `CLAUDE_CODE_EFFORT_LEVEL`。roadmap D4 解锁。隔离实例真 claude 全链路 + 浏览器实测 ✓。

---
**线性视图滚动已读修复（Session 48，已合入 main，fix commit `51d7dff`）**：已读判定从「仅 anchor 1s」改为 IntersectionObserver 视口停留 1s，滚动阅读即计已读；隔离实例浏览器实测 ✓。

---
**GitHub issue #2-#7 六个 issue 一轮清完并已合入 main 推送（Session 47，issue 全部 closed）** → 决策见 decisions.md 2026-07-14「统一阅读面」。#7 架构统一做透：NodeFullView/NodeTreeOverlay 退役、`fullScreen` 状态删除，线性 thread（共享 TurnCard + 视口贴底 Composer）成为全模式唯一阅读/对话面（关 #2/#4）；#3 画布 fixed DockedComposer；#5 首屏卡死修（busy 复位 + streamAlert toast）；#6 乐观占位节点 + 流式锁底。tsc/build ✓ + 隔离实例浏览器实测全绿；prod launchd 已重启。两个 commit：`3b61a2e`（Session 46 锁系）+ `6d40985`（issue 清剿，Closes #2-#7），均未签名（1Password 签名授权在自动化环境不可用，与 3d86cfc 同状态，需要可 rebase 补签）。

---
**Session 锁系 + codex 系内多模型已落地并全链路实测（Session 46，未 commit）** → 决策见 decisions.md 2026-07-14。「系」成为一等语义：新建会话自由选系，会话内 claude↔codex 互相置灰（防 resume 断链），系内切换自由；codex 扩成 `codex:<slug>` 复合 id（清单来自 `~/.codex/models_cache.json`，`-m` 透传）。真 spawn 验证 codex:gpt-5.4-mini / 原生 claude / deepseek 三路全通。**codex parity 后续两步（按 ROI）**：P0 = codex native resume（`~/.codex/sessions` rollout jsonl，需实测 CLI resume 语法）；P1 = codex 树分叉（前缀 rollout jsonl 可行性，需实测）；能力矩阵抽象随 P0 一起做。

---
**工作区收敛 + 积压 UI 验收全过（Session 45）**。6 个 feature 分支全部已 merge 进 main 并删除，main 已 push（`9add18d..1345c51`）。浏览器实测（快照 DB + 隔离 `next start` 3003）全绿：线性视图四项 / `/model` 动态 catalog / 命令面板 / 归档往返 / SessionTabs+⌘N / FTS 搜索。遗留小项见 Session 45 log。

---
**Project 线性 thread 主视图 + 树缩略图（已浏览器验收 ✓ Session 45）** → [spec](linear-thread-view-spec.md)。纯前端增量：project 默认 `viewMode=linear`，线性 thread 按 active lineage 展开，分叉折成行内入口，右下角 SVG 树缩略图导航；chat/workspace 的 canvas + NodeFullView 路径保持不变。真实会话（web3 实践，12 节点 1 分叉）实测：默认线性 ✓、「↳ N 个分支」展开 + 点分支卡切 lineage ✓、缩略图点任意节点跳转 ✓、画布↔线性往返保 active 节点 ✓。

---
**CLI ↔ trellis 分支对齐 P1+P2 全落地（含真 claude 端到端验）** → [P1 spec](cli-branch-alignment-p1-spec.md) / [P2 spec](cli-branch-alignment-p2-spec.md)。双向分叉对齐做透：P1=CLI→trellis（union 导入 + lineage 发现 + watcher 新 fork 检测）；P2=trellis→CLI（attached 会话续聊/分叉的 resume 重定向 + 构造前缀 jsonl）。P2 统一模型=分叉一律构造前缀 jsonl（弃 fork-session，见 decisions.md）。落地：`cli_lineages` 表 + per-node lineage sid + `attachedLineageForNode`/`buildPrefixJsonl`/`hasOtherChild`/`registerForkLineage`（`cli-fork.ts`）+ `/api/chat` origin='cli-import' 分支路由（tip 且无子→线性 resume 该 lineage；否则→前缀 jsonl 在 X 分叉成新 lineage + setNodeResumeId）+ `deleteNodeSubtree` 加 origin 闸防误删用户 jsonl。仅动 `origin='cli-import'`，原生 chat/workspace/project + `getRootResumeIdForNode` + 解析器内核零改。**验证**：P1/P2a fixture ALL PASS（独立跑、临时 DB）；**P2 翻盘性未知真 claude 闭环**——真会话 2 轮（香蕉→苹果）→ `buildPrefixJsonl` 截到 turn1 → 真 `claude --resume` 答「只记得香蕉」（不知被截掉的苹果）→ 程序化前缀 jsonl 可被真 claude 从任意历史点续上；`npm run build` ✓ + tsc ✓。**HTTP 全链路 e2e 已验收**（隔离 dev server + 真 claude：从历史节点分叉→`/api/chat`→spawn→reconcile→fork 子树正确长出、答案严格截到分叉点）。**已 merge 进 main 并 push（Session 45，分支已删）。**

---
**新功能定 spec(Session 31):CLI Session 同步** → [spec](cli-sync.md)。把本机 Claude Code CLI 的本地会话(`~/.claude/projects/*/*.jsonl`,88 个 project 目录)持续实时**镜像**进 trellis(只读浏览/搜索/导出,v1 不续聊)。需求确认:数据源=CLI jsonl、语义=持续实时同步、范围=opt-in 选择器。可行性已验(jsonl 字段↔节点模型一一对应,逐行结构已抽样钉死)。关键设计三点:(a) collapse 规则(真 user turn→节点,tool_use+tool_result→ToolCall[]) (b) 防回环去重(跳过文件名∈trellis 自有 session id 的 jsonl) (c) 只读镜像。分 4 Stage(A 解析器+一次性导入 → B 实时 watcher → C 选择器 UI+只读门禁 → D 可选续聊)。**CLI Session 同步 = per-session attach + 真双向,全做完并已部署 prod**(分支 `feat/cli-session-sync`,未 commit;详见 [cli-sync.md](cli-sync.md) + decisions.md)。设计经一次推翻(只读镜像→双向 attach)。落地:解析器/DB importer/discover/watcher/对账 + instrumentation boot + discover·attach API + CliAttachPicker UI(SessionSidebar 入口 + CLI 角标)。双向:CLI 侧新轮 watcher 自动同步进 trellis,Session 38 补上前端 SSE 事件通道后当前打开的 attach session 无需刷新会自动 reload;trellis 续聊走 project resume 写回同一 jsonl + done 后身份对账(删临时节点、canonical jsonl-uuid 接管、reload_session 通知客户端)。dev 端到端全验(含真实续聊写回 PONG + 浏览器实测 attach/detach/角标),`npm run build` ✓,launchd 重启部署、prod 路由 401(已上线被闸挡)。途中抓修:system 边界节点断链(致全孤根)、attach 删除 hazard(origin 闸挡)。**下一步:用户验收;按需 commit/merge。**

---
**Session 工作台层(Session 29)** → [spec](session-workbench.md)。原北极星「替代 GPT + Claude Code CLI」交互层已基本达成,下一道坎是「承载更多工作」——让 CLI 重度用户能像 tmux 一样并行承载多 session、靠肌肉记忆导航。已完成 recon(4 agent 并发测绘),关键发现:**执行引擎(run-bus)本就多 session 并发,墙在 store 单 active session 模型 + 缺导航/生命周期/命令 UI 层;一大半"迷惑"是可发现性而非能力缺失**。三组件:(a) tmux tab 导航 (b) session 生命周期正名 (c) 命令面板。**三波全部落地(Session 29-30,build ✓×3,UI 待浏览器实测)**:Wave 1(SessionTabs + `/api/runs`)+ Wave 2(B1 正名/B2 归档/B3 compact 降级)+ Wave 3(C1 命令面板,`/` 前缀触发 /new /clear /archive /switch /model)。deferred 项:Level B 多 session in-memory store 重构、`/model` per-session DB 锁定(均有产品语义未决,实测驱动再上)。**浏览器实测已过(Session 45)**:SessionTabs 预览/双击固定/⌘1-9 快切、`/api/runs`、归档往返、命令面板 /model /switch 实跑、FTS 搜索。

---
**费曼学习法 Phase 1 已落地**（Session 28，轻量预设版，未实测）。继续按 [optimization-roadmap.md](optimization-roadmap.md)（替代 GPT 体验优化）实施第一阶段 P0。**用户要求「一口气全做完」。已完成 15 项**（全部 `npm run build` ✓）：
- P0：A3 代码块/回复复制 · B2(并入) · D1 System Prompt 可配 · A4 Enter 发送 · A1 全屏流式 markdown · B1 移动端 Outline 抽屉 · A2 编辑=新分支重问 · C2 记忆桥接(写侧) · C1 文件附件(code/text 子集)
- P1/P2：B5 a11y · B4 首屏建议 · A5 Alt+方向导航 · D2 上下文 depth 可调 · D5 多版本对比 · C4 Skill 入口

**剩余（每项有明确状态，非遗漏）**：
- C1 PDF/Excel/Word — 二进制需 npm 装 sheetjs/pdf/mammoth 解析（code/text 子集已做）
- C5 / A6 / B3 — 评估低 ROI 暂缓（理由见 P1/P2 清单，简洁优先）
- ~~D4 thinking — SDK 无 thinking 事件，blocked~~ → 已解（Session 52，SDK 是自家的了）；D3 工具闭环 — 疑底层已覆盖待确认
- C3 语义检索（Q2 embedding 未决）· C6 图片生成（Q3 倾向不做，走 ai-legion）

**全部待浏览器实测**（dev server 在 3001）。roadmap 的 Stage 20/22（plan 节点/subagent 可视化）仍属功能广度归原 roadmap。本轮补的是交互/UI/对话内核体验维度。

## Goals
### Short-term (MVP)
- [x] Stage 1: Next.js 脚手架 + 依赖
- [x] Stage 2: Mock SSE endpoint — curl 验证流式 OK
- [x] Stage 3: 数据模型 + SQLite + Zustand
- [x] Stage 4: Canvas + ChatNode + 根节点流式渲染
- [x] Stage 5: 选中文字 → ⌘K 分叉
- [ ] Stage 6: Polish
  - [x] 大纲（`components/Outline.tsx`）
  - [x] 持久化恢复（hydrate from `/api/sessions`，`stores/sessionStore.ts:70-91`）
  - [x] 父节点高亮回显（parentAnchor badge，`ChatNode.tsx:70`、`NodeFullView.tsx:130`）
  - [x] 节点序号 + 已读未读（`lib/node-index.ts`、`read_at` 列、`/api/nodes/[id]/read`、Outline 顶部计数 + 只看未读）
  - [x] 跳回父节点滚到 mark + pulse（`pendingScrollAnchor` store state、`.anchor-pulse` 动画）
  - [x] 进阶定位三件：J/K 跳未读（`hooks/useUnreadNavigation.ts`）+ compact dot 颜色编码已读未读 + done toast（`components/DoneToast.tsx`）
  - [x] Token 细分四桶（input/output/cacheRead/cacheCreation）`lib/format-tokens.ts` + 全链路 schema/provider/UI
  - [x] 笔记本（`app/api/notes/`、`components/NotesDrawer.tsx`、⌘D + 📌 按钮、Header 入口）
  - [ ] Dagre 布局微调（实测后再判断是否真有痛点）
- [x] Stage 7 P0: 移动端全屏卡片 + 顶栏 + 分支条
- [x] Stage 8: 三层视图统一 — Layer 1 图 / Layer 2 聚焦 / Layer 3 全屏；桌面手机共享全屏组件
- [x] Stage 9: NodeFullView 加全树 overlay（远端跳转）+ 失败节点 in-place retry + Codex 打包修
- [x] Stage 10: 选区分叉不切焦点 + mark 可点跳子 + 树 overlay 改右侧抽屉 + 上下文压缩（depth=2 + 锚点 excerpt）
- [x] Stage 11: 发送/取消 UX — Cmd+Enter 发送 + 流式 ⏹/Esc 中止 + 保留 prompt → [spec](cancel-send-ux.md)
- [x] Stage 12: 节点类型抽象 + 参考卡片（粘贴/URL）+ 画布凭空建节点 → [spec](reference-nodes.md)
- [x] Stage 13: 画布 FAB 升级 popover（新提问 + 参考卡片）+ 链接抓取 prompt goal-only 化

### Mid-term
- [x] 接真 LLM（Claude Sonnet/Opus/Haiku + Codex 半成品，default sonnet）
- [x] 思维树导出（`lib/export.ts`：JSON + Markdown，Feishu 友好）

### 2026 Q2: 替代 Claude Code CLI + GPT 客户端 → [roadmap](roadmap-2026q2.md)
**Wave 1 (Week 1-2) — Chat 立得住，Workspace/Project 有 cwd**
- [x] Stage 14: 模式重命名（lean/cli-single/cli-multi → chat/workspace/project）+ Workspace 引入（session 级 cwd 绑定 + WorkspacePicker + 创建流程改造）→ [spec](mode-workspace-rebuild.md)
- [x] Stage 15: 图片输入（vision，三档全模式可用，多模态走 claude/codex 原生）→ [spec](vision-input.md)
- [x] Stage 16: 跨 session 全文搜索（FTS5 trigram + ⌘P 全局搜，按 mode facet）→ [spec](fts-search.md)

**Wave 2 (Week 3-4) — Workspace/Project 超过 raw CLI**
- [x] Stage 17: Tool call / Bash 可视化（解析 stream-json 的 tool_use/tool_result，节点折叠区展示）+ durable streams 改造（spawn 与 HTTP 解耦，断线不杀生成）
- [ ] Stage 18: Skill 调用入口（输入 `/<skill-name>` 触发，复用 ~/.claude/skills/ 50+ skill）
- [x] Stage 19: 文件附件（Session 50 落地，形态调整：进 composer 附件而非 reference 节点——CSV/文本/PDF 等通用文件走「blob + staging 路径注入 prompt」，agent 自己用工具读）

**Wave 3 (Week 5-6) — 树状结构优势放大**
- [ ] Stage 20: Plan 节点 type（计划-步骤-子节点联动，对齐 Plan → Execute → Verify → Learn）
- [ ] Stage 21: Memory 桥接（节点 ↔ ~/.claude/memory/ 双向）
- [ ] Stage 22 (可选): Subagent 子树可视化

### GPT 替代体验优化 → [optimization-roadmap.md](optimization-roadmap.md)
体验深度维度（交互手感 / UI 精致 / 对话内核），与上面功能广度互补。第一阶段 P0：
- [x] A3 代码块语言标签+复制 + 回复全文复制（+B2 并入）
- [x] D1 System Prompt 可配（5 预设角色+自定义，per-session 锁定）
- [x] A4 Enter 发送可配（默认 Enter 发送，对齐 GPT；可一键切回 ⌘Enter）
- [x] A1 流式实时 markdown（NodeFullView 全屏；画布卡片维持 textContent 直写保性能）
- [x] B1 移动端 Outline 抽屉（Header ☰ 开全屏抽屉，variant prop + page 顶层挂载；响应式卡片宽度评估后不做——600px 是 dagre 布局基准、移动端走全屏不看画布，保留）
- [x] A2 编辑消息（全屏问题区铅笔→改问法重问；`editNode` 复用 streamBranch/streamRoot，Q1=B 新建 sibling、原问答保留无损）
- [x] C2 记忆桥接（写侧）：新 `app/api/memory/route.ts` 写 `~/.claude/memory/{slug}-{hash}.md`（auto-memory 格式 + MEMORY.md 索引，防覆盖）；NodeFullView `MemorySaveButton` popover（标题/内容可编辑 + type 选择，用户点击触发写入）。自定义指令部分由 D1 覆盖。读侧（节点旁显示相关 memory + session init 注入）标注 follow-up。
- [x] C1 文件附件（code/text 子集）：ReferencePicker 加「📎 从文件读取」，FileReader 读白名单扩展（.py/.ts/.md/.json/.csv 等 30+）→ 包代码块填入 paste reference（≤1MB）。**PDF/Excel/Word 未做**：二进制需 npm 装 sheetjs/pdf/mammoth 解析，留新上下文 + 依赖决策。

**用户已确认「一口气全做完」。P1/P2 进度（含开放决策处理）：**
- [x] B5 a11y（globals.css `:focus-visible` 键盘焦点环；userScalable 保留=画布需要）
- [x] B4 首屏建议问题 chips（QuestionInput，chat 模式空输入时）
- [x] D2 上下文 depth 可调（store historyDepth 默认 4=原硬编码 2 翻倍缓解深树丢上下文；footer 📚 stepper 2/4/6/8；全链路传 maxDepth 给 buildHistoryForNode）
- [x] A5 节点键盘导航（Alt+方向键：上=父 / 下=首子 / 左右=兄弟；新 useNodeKeyboardNav hook）
- [x] D5 同问多版本对比（「再答一版」= editNode 同问题建 sibling，复用兄弟条对比，零新机制）
- [x] C4 Skill 入口（新 `/api/skills` 扫 `~/.claude/skills/*/SKILL.md` 取 name+desc；QuestionInput 输入 `/` 触发 picker 补全 `/name `，由 claude CLI 原生执行；仅 workspace/project 模式）
- [ ] C5 模型 session 级 — **评估暂缓**：现全局切换已可用且更灵活，session 锁定反而削弱灵活性、且「锁定 vs 每轮可选」语义需产品决策，低 ROI
- [ ] A6 命令面板 — **评估暂缓**：现有快捷键（J/K 未读、B 回父、F 全屏、⌘K 分叉、⌘P 搜索、Alt+方向导航）已覆盖高频操作，命令面板边际
- [ ] B3 长回复折叠/TOC — **评估暂缓**：现 max-h 滚动 + 全屏阅读已覆盖核心阅读，TOC 边际（简洁优先）
- [ ] C2 记忆桥接、C1 文件附件（见上 P0）
- [x] D4 thinking 可视化（Session 52：@sm/agent 加 `EventType.Thinking` + trellis 全链路 + TurnCard 思考面板/画布指示器；thinking 不落 DB，ephemeral 与 CLI 折叠行为一致）
- [ ] D3 工具结果闭环 — 待确认：tool result 回灌模型可能 agent-gateway/CLI 已自带，trellis 只做可视化
- [ ] C3 语义检索 — **开放决策 Q2**（embedding API）未拍板，暂不做
- [ ] C6 图片生成/语音 — **开放决策 Q3 倾向不做**（付费 API + 偏离单机定位，走 ai-legion skill）

### Session 工作台层(tmux 式多 session)→ [spec](session-workbench.md)
下一道坎:让 CLI 重度用户并行承载多 session + 靠肌肉记忆导航。三波:
**Wave 1(导航先立)**
- [ ] A1: 常驻 session tab 条 + mode 色标 + ⌘1-9 快切(Level A,不重构 store)
- [ ] A2: live 状态点(新 `/api/runs` 暴露 run-bus RUNS 快照,tab 上显示 streaming/done/error)
- [ ] A3: tab 条按 mode 分区(Chat 区 / Workspace·Project 区,借 SearchModal mode facet)

**Wave 2(生命周期正名)** — Session 30 落地(build ✓ + curl 验证 archive 往返)
- [x] B1: 「新提问」→「🧹 新话题(清空上下文)」正名;NewQuestionPicker 🧹 badge + `/clear` 文案对所有 mode 统一(原仅 project);FAB/SessionPicker/Header 文案对齐。仅改标签文案,createRootInSession 行为不变
- [x] B2: 归档机制(`sessions.archived INTEGER` idempotent ALTER + repo `setSessionArchived`/`countArchivedSessions` + listSessions 默认排除 archived + PATCH `{archived}` + store `archiveSession`/`unarchiveSession` + SessionPicker 行内归档/恢复 + 「显示已归档(N)」toggle)。归档纯隐藏不删 jsonl/节点。SessionTabs 未改(同 endpoint 自动受益)

**Wave 3(命令面 + 深水)**
- [x] C1: 通用命令面板(Session 30)。新 `lib/commands.ts` registry(`matchCommands`/`parseCommand`/`resolveProvider`)+ QuestionInput 提交拦截分流(纯 Trellis 命令本地执行不发 LLM,skill 照旧透传 CLI)+ `/` 下拉合并命令(前)+skill(后)。`/clear` 复用 Wave 2 `setComposeRootOpen`。仅接首屏 composer(命令是 session 元操作),追问框刻意不接 → **S55 推翻**:用户要求日常对话框也能用,共享 Composer 已接同一 registry
- [x] B3: `/compact` 降级提示(Session 30 随 Wave 2 一起做)。spike 确认 claude CLI/SDK 无原生 compact → 降级为 Header 🧠 ctx 徽章在 ≥50% 时变可点 popover(解释上下文压力 + 「🧹 开新话题清空」一键复用 createRootInSession,经 store `composeRootOpen` 标志驱动 AddNodeFAB 的 NewQuestionPicker)。<50% 保持非交互只读不打扰。不实现 summarize
- [ ] (deferred) Level B 多 session in-memory store 重构 / C2 per-session model

## Session Log
### Session 72 (2026-07-25)
- **Done**: 清仓 Aaron 两个 open PR（无 open issue）。#10 `fix(popover): IME 组合输入的回车不触发发送`（BranchPopover 单文件 IME 守卫）+ #11 `feat(canvas): 卡片原地展开预览(peek)`（Canvas/ChatNode/layout 三文件：compact 卡「展开预览」→ 原地 600×480 完整卡，`forceFullIds` 确定 footprint 单趟 reflow，多卡同开/收起折回，popover rendersFull 门控），均 `gh pr merge --merge` 合入并已在 GitHub 推送。
- **Review 要点**: #11 popover 门控最大风险 = 误伤其他选区路径，已排除——`data-chat-node-id` 仅 ChatNode（画布）/TurnCard（线性）携带，Canvas 与 LinearThreadView 互斥挂载，reference 卡无该属性；`rendersFull` 与 ChatNode `showCompact`（含 S64 errorSuperseded）语义镜像一致。#11 顺带的 FollowupInput 焦点环 px-1.5 wrapper 为无害 drive-by。
- **验证**: 合并树（origin/main + 两 PR）tsc ✓、touched 4 文件 lint 零新增（Canvas 2 项 `set-state-in-effect` 与 main 基线逐条对齐）、隔离 worktree（~/trellis-prcheck-tmp 共享 node_modules）`bun --bun run build` ✓；隔离实例 :3163（`TRELLIS_DB_PATH` 沙箱 + `env -u TRELLIS_AUTH_PASS` 关闸 + mock provider）agent-browser 全链路：建 2 节点树 → #1「展开预览」→ DOM 实测 peek 卡 600×480 z=1000、子卡 y=556（480+40 起点 +36 间距）无重叠、URL/视图不变未跳线性 →「收起」→ 两卡回 280×47、子卡回位 y=166。产物已清（browser session/server/worktree/临时 DB）。
- **仓库状态注记**: S71 三 commit（npm 化 + 模型配置）本地未 push（`@smokingmouse/*` npm 404，publish 闸未过）；已 `git rebase origin/main` 把它们叠到 PR merge 之上，rebase 后合并树 tsc ✓。shell 环境自带 `TRELLIS_AUTH_PASS/TOKEN` export——隔离实例起服务须 `env -u` 显式剥离，否则 401（本轮踩到）。
- **Next**: 用户 npm login → publish llm+agent → 两仓 push（S71 Next 原样）；PR 两功能上 prod = build + kickstart；#11 真机手感验收（peek 与 hover 预览卡并存的观感）。

### Session 68 (2026-07-19)
- **Done**: markdown 答案里图片本地路径破图修复（用户截图报「图没法预览」）。
  - 根因：`MD_COMPONENTS` 缺 `img` 渲染器——S63 只接管了 `a`（MdLink）和行内 `code`（InlineFileButton），`![alt](/Users/…/foo.png)` 的本地 src 直进 `<img>`，浏览器按 http 路径请求 404。
  - `components/HoverPreview.tsx` 新增 `MdImage`：`previewableHref` 判本地（绝对 / file:// / workspace 相对）→ `filePreviewUrl` 走 `/api/files` 白名单代理，onClick 开 FilePreview overlay；远程 URL 原样；`onError`/空 src 降级行内占位（🖼 + alt + S63 同款自解释文案）。`lib/md-components.ts` 注册 `img`。
  - 白名单政策零改动（S63 用户裁定不扩白名单）；服务端零改动。
- **验证**: tsc ✓ + lint 与基线持平（7 项均既有，途中清掉自己引入的 4 项：img any / _node unused / disable 注释错位）+ `make build` ✓；隔离实例（独立 HOME + mock project 会话，:3158 初测 / :3159 lint 清理后复测）四形态 + 点击 overlay 全过，产物已清（browser session / server / 临时目录）。
- **排查注记**: 用户截图会话（#171 · Turn）在本机 prod DB（~/.trellis/data.db，全库无 `![` 语法）、CLI jsonl、blobs 均无——应来自另一台部署（公司机）。序号 = `buildNodeIndex` 会话内计数，本机最大会话仅 124 节点，可交叉印证。渲染层代码共享，修复对所有部署生效。
- **Next**: 用户现场验收；上 prod = merge main + build + kickstart（S66 追记硬规则）。

### Session 62 (2026-07-17)
- **Done**: 线性视图内容列宽度可调（用户反馈卡片太窄，问能否加宽/可调/设置页）。
  - 新 `lib/thread-width.ts`：`ThreadWidth` 三档（narrow=max-w-3xl 768 / wide=max-w-5xl 1024 / xwide=max-w-7xl 1280），默认 **wide**（直接兑现「加宽」，可一键调回）。
  - store：`threadWidth` 偏好 + `setThreadWidth` + hydrate 恢复（key `trellis-thread-width`，全局非 per-session，照 sendKey 模式）。
  - `LinearThreadView`：三处 `max-w-3xl`（顶栏/main/Composer）换共享 `widthClass` 保持列对齐；顶栏 🗺 画布旁加「窄/宽/超宽」分段控件（`hidden md:flex`——移动端卡片本就贴满屏宽）。
  - 设置页：评估不做（偏好少且各有语境化入口，简洁优先）；偏好积累多了再上 Header ⚙ popover 归拢。
- **验证**: tsc ✓ + `make build` ✓；隔离实例（:3151 + 临时 DB + `TRELLIS_AUTH_PASS=` 关闸 + `/model mock`）agent-browser 实测：默认落 wide(1024)、点窄→768、点超宽→顶栏/main/Composer 三容器同宽 1070（viewport 1280 减侧栏后自然封顶，符合预期）、localStorage 写入 ✓、reload 恢复超宽档 ✓、截图目检控件位置/高亮正常。产物已清（browser/server/临时 DB/截图，:3151 已释放）。
- **Next**: 已提交推送 main（免签待补）；真机验收待用户。注记：readingPosition 存像素 offset，切宽度后卡片高度变化会让旧恢复位置略偏——一次性、无害，未做迁移。

### Session 61 (2026-07-16，原 60 与并行 session 撞号重编)
- **Done**: ThreadMinimap 悬停预览卡（用户给了 ChatGPT 会话 minimap hover 截图，要同类功能）。仅改 `components/ThreadMinimap.tsx`：
  - 点位 `g` 加 mouseenter/leave + focus/blur → `hover` state；预览卡绝对定位在面板左侧（`right-full mr-2 w-64`），垂直居中于点位 y（clamp 40..SVG_H−40），`pointer-events-none` 防抢 hover。
  - 卡内容：`#序号`（复用 `buildNodeIndex`）· Turn/Reference + 标题（`topicLabel ?? question` 摘要，clamp 2 行）+ 回答摘要（新增本地 `excerpt()` 剥 markdown——代码块/图片直接丢，clamp 4 行；error→「生成失败」，streaming 空响应→「生成中…」）。
  - 点位加 r=9 透明命中圈（原 r=3.5 可视点太小难悬停/点击）；悬停节点被删有 guard。
- **验证**: 本 worktree（preview）原无 node_modules，`bun install` + `make relink-sdk` 后 tsc ✓ + `make build` ✓；隔离实例（:3149 + 临时 DB + `/model mock`）agent-browser 实测：3 节点线性视图，真实鼠标移动悬停两点位 → 各自卡内容正确（标题/摘要/序号）、移开卡消失（查 DOM 元素而非 innerText——正文含同样文案会误判）、点击点位导航照常（active 高亮 + 线程跳转）。产物已清（browser session/server/临时 DB；默认 ~/.trellis/data.db 查证无泄漏）。
- **Next**: 已提交并合并推送 main（免签待补）。真机验收待用户。候选 follow-up：S57 遗留的「ThreadMinimap 移动端默认折叠」可与本功能一起调（移动端无 hover，预览卡天然不触发，无冲突）。

### Session 59 (2026-07-16)
- **Done**: 用户报的两个体验 bug 修复。
  - **①切卡滑动**：`LinearThreadView` anchor 导航 `scrollIntoView` 去掉 `behavior:"smooth"`（长 thread 切卡会肉眼滑过整屏内容才停），TargetChip label 跳转同改。
  - **②tab 串台**（根因 = `handleStreamEvent` `created` 不校验 session 就插入当前 nodes map 并 `focusNew` 抢焦点；发送后立刻切 tab 即复现「另一个 tab 也变成运行，内容是原 tab 的」）：
    - `created` 加 guard：`!event.session && s.session?.id !== node.sessionId` → 跳过 store 提交（run 服务端继续，切回时 loadSession + bus 缓冲接上；unread 角标由 run 轮询 diff 兜底）；`handleRefStreamEvent` created/done、`refreshReference` 同规。
    - `loadSessionInternal` 加模块级 `loadSeq` latest-wins：慢的旧加载（cli-sync session_updated 重载、连续快切）resolve 晚不再把视图翻回旧 session。
    - `useCliSyncEvents`：`event.sessionId === 当前` 判断改读 `useSessionStore.getState()`（原 closure 捕获值在切换窗口期 stale，运行中 attached 会话持续 session_updated 会把视图拉回去）；顺带 SSE 连接不再随每次切 session 重建。
    - **切走再切回重复文本修复**：`loadSessionInternal` 对仍 streaming 且本地有活订阅的节点——POST reader（bus pending 自 created 起为全量）→ 本地 response 置 ""（恢复 created 基线，防「DB 快照 + pending」拼接翻倍，done 提交同理受益）；活 reconnect 句柄（基线是旧 catchup，已不可考）→ 同步拆除 + 清 bus，靠随后的 reconnect pass 重挂拿新权威 catchup。`jumpToSearchHit` 补调 `reconnectStreamingNodes`。
- **验证**: tsc ✓ + `make build` ✓；隔离实例（:3145 + 临时 DB + mock，`/model mock`）agent-browser 实测：A 流式中切 B → B 无 streaming cursor/停止按钮、canvas 只有自己节点；流式中切回 A（`backWhileStreaming:true`）→ 继续流、done 后 DB（578 字符 ×1）与可见渲染（marker ×1）均单份。产物已清（browser session/server/临时 DB）。**排查注记（防复踩）**：TurnCard 的 `innerText` 恒为回答约两倍——`CardImageButton` 内有 off-screen 分享卡副本（`left:-99999` + aria-hidden），量 DOM 文本断言时须 clone 后剔除 `[aria-hidden="true"]`，非 bug。另：首轮实测点 ModelPicker 下拉选「Mock 调试用」未生效吃了两次真模型短答，改用 `/model mock` 命令可靠。
- **Next**: 未 commit（4 文件：LinearThreadView/sessionStore/useCliSyncEvents/progress），用户验收后提交；真机复核两个原始症状。若「串台」仍在，需要精确操作序列——本轮修的是 created 竞态 / 加载竞态 / cli-sync 回拉三条已证实路径。

### Session 58 (2026-07-16)
- **Done**: **Workspace 档退役,模式收敛 chat / project 两档** → decisions.md 2026-07-16。证据链:DB 全库 0 workspace 行(原生 chat 21 / project 11);机制上 workspace ≡ project − resume(减掉的恰是仓库干活要的跨轮记忆);「一次性 CLI」定位已被 S55 增强 chat(scratch + full + skill 自动开)吃掉。改动面:
  - 类型/机制:`Mode` 二值联合(types.ts 附退役注记);sdk-adapter 删 workspace 分支、`toStreamEvent` 去掉死参 `mode`(SessionStart 恒透传);route `VALID_MODES` 二值,老 `mode:"workspace"` isMode 兜底回落 chat。
  - store:isMode 二值;loadDraftMode legacy 迁移(`cli-single`/`workspace`/旧 flag → project)。
  - UI:ModePicker 两 chip(project 文案并入 per-lineage 语义,TerminalIcon 删)、SearchModal facet、SessionSidebar 分组「Project」、ModeBadge 删 workspace 条目/图标、WorkspacePicker 高亮色 mode-workspace→mode-project。
  - token:globals.css `--mode-workspace-*` 全主题块 + `@theme` 注册全删;mode-style 二值。
  - DB:migrate 加幂等 `UPDATE context_mode='workspace'→'project'`(本机 0 行,防御其他部署)。
  - 文档:README 两档表 +「历史注」+ Chat 增强模式补写(此前文档缺失);全仓注释 workspace/project 措辞清理。
- **验证**: tsc ✓ + `make build` ✓;隔离实例(:3141 + 临时 DB 拷贝 + 种假 workspace 行 + env 覆盖关 auth 闸,不动 .env.local):migration 读出 mode=project ✓、mock 三路创建(chat/project/legacy workspace→chat)✓、GET / 200 ✓;产物已清(server kill + 临时 DB 删)。
- **Next**: ~~commit~~ 已提交推送(`4818681`,`--no-gpg-sign` 免签同 3b61a2e 待补签;working tree 无其他改动,单 commit 干净收口);用户真机验收两档 ModePicker。候选 follow-up:codex project 树分叉语义(线性共享 session 分支互染,原 workspace 是干净解——被绊到再把 codex project 历史构造降级折叠 prompt,见 decisions Alternatives①)。

### Session 57 (2026-07-15，原 56 撞号重编)
- **Done**: **主题系统 + 界面&交互整体优化**（worktree/分支 `trellis-theme`，基 main ce3481e，8 commits，f464c49..ac54e85）。前置：两份静态审计（视觉设计系统 + 交互流程，各出债务 Top10）+ 用户拍板（三线全做 / 主题系统 / 5 套主题 / 主按钮=accent / 代码字体系统栈）。分 8 wave 执行，决策全录 → [ADR](decisions/2026-07-15-theme-system.md)：
  - **W1-W2 token 层**：globals.css 双层变量（:root/.dark 级联块 + `@theme inline` 注册 utility）——中性族/语义 hue（含 amber 四分、unread/fork 独立 hue）/字号 6 档/圆角 3 档/阴影 3 档；~40 处裸 hex 全变量化；hljs light 死代码删除（「代码块恒暗」据实转正）；`color-scheme` 让 dark 原生滚动条变深（有意改进）。零 diff 验证 = 浏览器 computed-style 逐字节断言 + 截图 diff（残差定位为焦点态/滚动条噪音）。
  - **W3 主题状态**：useTheme {mode,palette}（storage 兼容零迁移）+ 预水合脚本 + ThemeMenu（外观三段 + swatch）+ `/theme` 命令；localStorage 四态矩阵实测。
  - **W4 原语**：`components/ui/` 九件（Button/IconButton/Popover/Modal/Drawer/ToastShell/Pill/StopButton/Dots）+ 进场动画（reduced-motion 豁免）+ pilot 迁移。
  - **W5+W5.5 全量迁移**：5 个并行 subagent 按批清完 40+ 组件（全仓调色板 class 与 text-[Npx] grep 清零）；黑按钮升 primary、节点未读 amber→emerald、NoteRow→positive、ChatNode 已读侧条改中性（撞色裁决）；`--color-X-*: initial` 闸门为永久回归护栏。ChatNode 零重渲染纪律未破（纯 class 替换）。
  - **W6 四主题**：paper（米白+青墨）/terminal（石墨蓝黑+荧光青）/morandi（灰绿+雾蓝，状态色全降饱和）/contrast（纯黑白+AAA）；4×2 截图矩阵 ✓。级联规则：light 块设过的变量 dark 块必须重设。
  - **W7 交互九项**：①useIsMobile→767px 与 md: 同线（修「窄窗口 sb 不归零挤右半屏」确定性 bug，390px 实测恢复）②「＋新会话（全新树）」vs「🧹 新话题」正名 ③`lib/shortcuts.ts` 注册表 + `?`/`/help` KeyboardHelp 面板 + `isEditableTarget()` 换掉 5 处重复 guard ④RunSpinner 退役统一 Dots ⑤TargetChip 归一画布/线性目标指示 ⑥移动端思维树入口换树形 icon ⑦🧠 徽章恒按钮（<50% 只读弹层）⑧Outline/移动侧栏/FAB 菜单补进场动画 ⑨移动端 SessionTabs 隐藏 + 内容 pt responsive。
- **验证**: 每 wave tsc + `make build`（共 6 次全绿）；隔离实例（快照 DB /tmp + :3131 + agent-browser）：截图基线→零 diff 断言→5 主题矩阵→390px/桌面回归→**mock 全链路流式回归**（建会话→/model mock→发送→流式 Dots/run-bar/未读 pill→done）✓。测试产物全清（server/快照 DB/浏览器 session；截图留 /tmp/trellis-theme-shots 备查，重启自清）。
- **坑（工具）**: agent-browser 本轮三次页面莫名跳 about:blank（eval 报错后/带 CSS 选择器的 click 后/daemon 重启丢 media 模拟状态）——重 open 恢复；截图前显式 `set media`，点击用 eval DOM 直点（S54 教训延续）。
- **merge 追记（2026-07-16）**: `git merge origin/main`（权限确认 04a9c18）在 trellis-theme worktree 完成——main 工作区留有并行 session 未提交 WIP（ChatNode/Composer/QuestionInput）不可在彼处操作，故反向 merge 后直接推 `HEAD:main`，prod 工作区本地 main 落后一截由该 session 自行 pull。冲突 3 文件：InteractionForm（对方 icon/title 参数 + 我方 token class 合成）、ModePicker（双 import 都留）、progress（S56 撞号，本轮重编 S57）。**权限确认的新 UI（PermissionForm 权限卡/ModePicker 🛡️ 开关）为 token 化前写就、会被 W5.5 闸门打哑，随 merge 一并迁移 token**（allow=accent 填充、always=accent 淡底、deny=warn、命令块=surface+line，全仓 grep 复归 0）。tsc+build ✓ + 隔离实例 smoke ✓。
- **Next**: 用户真机验收（重点：手机布局、5 套主题观感、? 面板、新 accent 主按钮、权限卡新配色）；commit 均 --no-gpg-sign 待补签。候选 follow-up：ThreadMinimap 移动端默认折叠（在手机上盖内容，未在本轮范围）；terminal 主题可选装 JetBrains Mono。

### Session 56 (2026-07-15)
- **Done**: **权限确认（Permission Gate P0）落地** → [spec](permission-gate.md) + decisions.md 2026-07-15。缘起：botmux（tmux 会话常驻/attach 模式）对照讨论 → 拆解出「权限确认不需要终端，stream-json control protocol 是结构化正解」（终端逃生舱=P1 等触发）→ 用户拍板直接实现。
  - **关键实测发现**：`--permission-mode default` 下本机全局 settings.json 裸 `Bash` allowlist 直接放行、can_use_tool 永不触发——审批必须注入 `--settings '{"permissions":{"ask":[Bash,Write,Edit,MultiEdit,NotebookEdit]}}'`（ask > allow 优先级实测坐实，claude 2.1.207）。
  - **SDK**（~/sdk，dist 已重建）：`RunOptions.askTools?: string[]` → ClaudeBackend 注入 `--settings`（纯机制，工具名单留 trellis）。
  - **trellis**：`sessions.require_approval` migration + repo/Session 类型全链；chat route 创建钳制（claude 系 + 非 chat）+ branch/retry 从 session 行读；sdk-adapter approve → permission "default"+askTools（`req.onCanUseTool` 在场才生效，天然隔离 codex/mock）；run-bus dispatcher approve 分支（不再 auto-allow → 复用 A路② PendingInteraction 全管道）+ `approvedTools` per-run「总是允许」+ resolveInteraction opts；respond route `alwaysAllowTool`；UI = ModePicker 🛡️需确认/⚡YOLO 开关（draft localStorage）+ InteractionForm 新 PermissionForm（Bash 命令等宽块/入参 JSON + 允许/本轮总是允许/拒绝+理由）+ ModeBadge 🛡️ 角标。A路② 既有 AskUserQuestion/ExitPlanMode 与 YOLO 会话零变化。
- **验证**（全绿）：协议探针 allow/deny；隔离实例（:3123 + 临时 DB + 真 claude haiku）HTTP e2e 四场景 = allow 弹卡→执行 / deny 不执行+理由回模型+正常 done / always 两 Bash 只弹一卡 / yolo 零卡回归，mid-pause catchup 带 pendingInteraction（刷新恢复卡片）；agent-browser 实测 开关→建会话→权限卡渲染→允许→执行→答案正确 + Header 🛡️徽章；tsc ✓ + `make build` ✓；prod kickstart（login 200/api 401）。测试产物全清（server/临时 DB/ws/probe/两个 claude projects 测试目录）。
- **并行注记**：本轮与 S54/S55 同目录并行开发（发现时 S55 已 commit 到 main，另留有未 commit 的 Composer/QuestionInput/ChatNode 小改动）；文件零交集、无冲突，但 **commit 时两批改动需分开摘**（本轮 14 文件 + permission-gate.md；SDK 侧另一 repo 一并 commit）。
- **Next**: ① ~~commit~~ 已提交推送（trellis `04a9c18` + sm-toolkit `924444c`，均 `--no-gpg-sign` 免签同 3b61a2e 待补签；S55 残留 Composer/QuestionInput/ChatNode 未 commit 改动已分摘留在 working tree）；② P1 候选：终端逃生舱（tmux 包 `claude --resume` + ttyd web 终端，回程复用 CLI sync watcher）等真实需求触发再做；③ 可选 follow-up：权限决议审计日志、三档权限演化（+acceptEdits）。

### Session 55 (2026-07-15)
- **Done**: **`/` 命令接入日常对话 Composer + 下拉键盘导航（推翻 S30「追问框刻意不接」的取舍，用户明确要求；worktree `增加工作区目录`，与 S54 撞号重编为 S55）**。共享 `Composer.tsx`（线性 sticky footer + 画布 DockedComposer）此前只接了 skill 补全，`lib/commands.ts` 的 Trellis 命令只有首屏 QuestionInput 能用。三处改动，registry/命令语义零改：
  - `SkillPickerList` 扩成命令+skill 合并下拉（可选 `commands`/`onPickCommand` props，命令在前带 ⚡ 徽章，与首屏下拉同序；ChatNode 行内追问框传参不变、向后兼容）。
  - `Composer` 接 `matchCommands`（全模式一等，skill 仍 gated on toolCapable）+ 提交拦截 `parseCommand`（裸 /command 本地执行不进 LLM，拦截在 targetNode/isStreaming 闸之前——/new /switch 不需要目标节点）+ cmdNotice 行内提示（下次击键清除）；下拉点选无参命令立即执行、/model 填 `"/model "` 待补参，与 QuestionInput 同约定。
  - **顺手修存量 bug**：`composeRootOpen` 消费从 AddNodeFAB（仅画布挂载）上移到 `page.tsx` 顶层——此前线性视图里 Header B3「开新话题」和 `/clear` 置了 flag 没人消费，静默无效且切回画布时 picker 突然弹出。FAB 只保留自己的菜单流。
  - **键盘导航**：新 `hooks/useSlashNav.ts`（↑↓ 循环高亮 + Enter/Tab 选中；query 变化重置到首项、纯方向键不重置；`handleKeyDown` 返回 true 表示已消费——调用方放在 send-combo 判定**之前**，下拉可见时 Enter 选中而非把半截 "/cle" 发给 LLM，无匹配时零干扰）。三个消费方全接：共享 Composer（命令+skill 合并索引）、首屏 QuestionInput（同）、ChatNode 行内追问框（仅 skill）；下拉加 `activeIndex` 高亮 + scrollIntoView(nearest) 跟随。
- **验证**: tsc ✓ + `make build` ✓ ×2；隔离实例（:3096 + 临时 DB + mock provider，产物已清）agent-browser 实测两轮：命令轮——线性 Composer 输 `/` 出 5 命令（纯 chat 无 skill）、`/cl` 过滤、点 /clear 在**线性视图**弹 NewQuestionPicker（修复生效）、`/model` 无参回显用法且保留输入、`/model mock` 切换生效+清空输入、增强模式命令+skill 合并（5+6）、`/switch` 开搜索、`/new` 回首屏；键盘轮——默认高亮首项/↓↓ 移动/↑ 循环到尾/Enter 执行 /switch、"/cl"+Enter 出 no-session notice、含空格 "/model mock" Enter 正常走提交拦截、线性 `/`+↓+Enter 弹「新话题」、↓×5 跨命令到 skill + Tab 补全、"/arch" 过滤重置 + Enter 真归档。ChatNode 行内框未浏览器验（同 hook 同约定）。**merge 注**：与 S54 的 Composer 改动（onSubmitted/onEscape/focusToken）自动合并成功，Esc 不被 slashNav 消费、落到 onEscape 语义不冲突。
- **Next**: 用户真机验收。
- **追记（2026-07-16 落地 commit）**: S55 残留 WIP——**skill 下拉全模式可见 + 纯 chat 点选自动开增强模式**。三输入框（Composer/QuestionInput/ChatNode 行内）`useSkillSuggestions` 一律全量显示；纯 chat 点 skill 自动 `setChatEnhanced(true)` + cmdNotice「⚡ 已自动开启增强模式」（skill 需要工具，藏下拉读作"skill 坏了"）；QuestionInput skill 列表懒加载去 skillCapable 门槛。主题系统 merge（88fc72d）后 stash pop 零冲突落回，tsc ✓ + 隔离实例浏览器实测 ✓。

### Session 54 (2026-07-15)
- **Done**: **线性视图中间节点自由分叉（reply-to 式 chip，方案 A）**。用户痛点：线性页面对中间节点岔开提新问题只能划线 ⌘K（BranchPopover 需要文本锚点，问题与原文无关时被迫造假锚点）；数据层 `streamBranch(parentId, q, null)` 本就支持自由分叉（画布 DockedComposer 在用），纯 UI 缺口。落地（仅改 2 文件，store 零改动）：
  - `LinearThreadView.tsx`：卡片头 actions 区加 ⑂ 按钮（`branchFrom {id,n}` state，n 为 nonce 供重复点击再聚焦；tip 卡不显示——从 tip 分叉=普通续聊；streaming 卡不显示）；底部 Composer 上方渲染 indigo chip「⑂ 从 #N 分叉 · 题干」（点题干滚回该卡，✕ 清除）；armed 时 Composer targetNode = 分叉节点、placeholder 变「从 #N 分叉提问…（Esc 取消）」；session 切换 / 目标节点被删自动清 chip。
  - `Composer.tsx`：+3 可选 prop——`onSubmitted`（提交后清 chip）、`onEscape`（textarea 内 Esc 清 chip，遵循 useEscapeAbort「textarea 内 Esc 归局部语义」约定，零冲突）、`focusToken`（arm 时拉焦点进输入框）。
  - 提交后走既有 `focusNew=true` 语义：active 跳新支线、线性视图重锚展开新 lineage，原卡自动折出「↳ N 个分支」。
- **验证**: tsc ✓ + `make build` ✓（main ASCII 路径）。隔离实例（快照 DB /tmp + `next start` :3112 + 临时挪开 `.env.local` 关 auth 闸后立即还原 + mock provider）浏览器实测：⑂ arm → chip/placeholder/自动聚焦 ✓；textarea 内 Esc 清 chip ✓；✕ 清 chip ✓；mock 会话 2 节点后从 #1 分叉发送 → chip 自动清除、thread 重锚为 [#1,#3]、#1 折出「↳ 1 个分支」、点分支卡切回 [#1,#2] 往返 ✓；tip/streaming 卡无 ⑂ ✓；chip 视觉截图核对 ✓。测试产物：server 已 kill、浏览器 session 已 close；/tmp 下快照 DB 等临时文件删除命令被拒（`/tmp/trellis-branchtest.db*` 等仍在，重启自清或手动删）。
- **坑（工具）**: agent-browser ref 点击在 React 重渲染后 stale（点了没反应但报 ✓ Done），换 `eval` DOM 直点即稳——同类 UI 实测建议直接用 eval 点。
- **Next**: 已 commit + push（免签，同 3b61a2e 待补签）；真机/手机验收；候选 follow-up：画布模式是否也要 per-node ⑂ 入口（现画布靠选中节点已覆盖，倾向不做）。

### Session 53 (2026-07-15)
- **Done**: **收敛工作机对 CHAT 修复的四个补丁**（工作机 pull a29f9b5 后仍 0 输出，自行打了四个本地补丁；逐条评估后收敛）：
  - **#1 `--setting-sources ""` 被 runtime 吞空 argv** → 采纳但改形式：SDK 上游化为 `--setting-sources=` 等号写法（sm-toolkit `0326299`），语义不变；工作机临时用的 `=local` 不采纳（通用 SDK 会在真实 cwd 突然加载 .claude/settings.local.json，语义漂移）。本机 bun 1.3.14 实测不吞空 argv（不复现），等号形式对 runtime 差异免疫。
  - **#2 SDK 手工加 Thinking 事件** → 重复实现，上游 `a3ce7b2` 已有；工作机收敛 = revert 本地 src 改动后 pull + rebuild。
  - **#3 instrumentation 强制 effort=low（全局）** → 收敛成 **per-mode**：纯对话 chat 在 `modeToRunOptions` 下发 `env:{CLAUDE_CODE_EFFORT_LEVEL:"low"}`（GPT 式即答场景，"你好"不该思考半天）；增强 chat / workspace / project 是干活 agent 保持 CLI 默认不降智；instrumentation 的 scrub 保留（唯一显式下发点 = RunOptions.env，优先级高于继承 env）。
  - **#4 plist 硬编码 ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY** → **不上游，本机严禁照抄**：env 注入优先于 OAuth（sdk Verified Facts），有原生 claude 登录的机器会把原生模型全部劫持到代理。工作机（无原生登录、全走 super-relay）能用但更优解是把 `SUPER_RELAY_AUTH_TOKEN` 放 `~/.agent-gateway.env`（endpoints.yaml env_file 机制，@sm/llm 解析时注入 → ClaudeBackend 按 model per-spawn 注入 base_url+token，多模型路由保持正确）。
- **验证**: sdk rebuild + 双侧 tsc ✓；`--setting-sources=`/`=local` 裸 CLI 实测均接受；隔离实例（:3124 + 临时 DB + auth cookie 过闸 + 真 claude-haiku）纯 chat：`created→thinking×7→delta→done`、回答正常、usage 齐全——等号参数真 spawn 通过、low effort 下 thinking 秒级且面板可见。prod 已重建 + kickstart。
- **Next**: 工作机收敛清单（见 sdk progress 同日条目）：①`cd ~/sdk && git checkout -- packages/agent/src && git pull && bun run build`（丢手工补丁换等价上游）②trellis `git checkout -- instrumentation.ts && git pull && make build` + 重启 ③plist 的 ANTHROPIC_* 三行可留可换 env_file 方案（换则删行 + 把 token 写进 ~/.agent-gateway.env）。

### Session 53 (2026-07-15)
- **Done**: **工作区文件抽屉**（分支/worktree `增加工作区目录`，commit `3a64f4b`）。动机：文件可见性链条缺最后一环——上传（Stage 19）/生成（GeneratedFilesBar 只覆盖回答里提到的路径）/空白沙箱（S49，产物散在 `~/.trellis/scratch` 无入口），远程/手机场景无终端可取件。形态拍板：**按需抽屉（只读浏览 + 预览），不做常驻 IDE 面板**——入口 = Header ModeBadge（有 workspacePath 时变可点 button，chat 保持静态 chip）。
  - 新 `GET /api/sessions/[id]/files?dir=<abs>`：单层非递归列目录，围栏 = session cwd realpath 前缀（`dir` 必须绝对路径；symlink 一律不列，指向 cwd 外的目录 realpath 后 403）；隐藏 dotfiles/node_modules/__pycache__/venv，**保留 dist/build**（agent 产物常落那里，与 workspaces/browse 的隐藏表刻意不同）；单目录 300 条截断标记。
  - 新 `components/WorkspaceFilesDrawer.tsx`（NotesDrawer 同款骨架：桌面右侧 360px / 移动端 60vh 底部 sheet）：惰性展开子目录、文件行显示 kind 图标+大小、点击 `openFilePreview(absPath)` 复用全局 FilePreview（**预览围栏零改动——`sessionAllow` 本就放行整个 cwd**，store 注释里预留的 "future workspace browser" 正是此物）；每次开抽屉 epoch 重挂载强制刷新 + ⟳ 手动刷新。store 加 `workspaceFilesOpen`（UI-only）。
- **验证**（临时 ASCII worktree + 隔离 dev :3095 + 临时 DB + mock provider，产物已全清）：curl——根/子目录列表正确（dotfile/node_modules/symlink 均不出现，/tmp→/private/tmp realpath 归一）；围栏 `/etc`、symlink 逃逸（`ln -s /etc`）、前缀同胞目录（`ws-testXX`）全 403、相对路径 400、无 workspace session 404；`/api/files` 预览联动 200。agent-browser——badge 点开抽屉、展开子目录、点 report.md 开 FilePreview（markdown 渲染）、**Esc 分层**（第一下关预览第二下关抽屉，FilePreview capture-phase stopPropagation 生效）、390px 视口底部 sheet 正常。`tsc --noEmit` ✓。
- **★ Verified Fact：中文路径 worktree 会炸 Turbopack**（与 Session 52 独立撞上同一坑，互证）。ident 截断按字节切、落在多字节字符中间直接 Rust panic（`start byte index N is not a char boundary`，turbopack-core/ident.rs）。`make build` 在中文 worktree 必炸；**dev 模式按 route ident 字节长度选择性炸**——存量 route 都能跑，本 feature 新 route 恰好中招（500）。worktree 目录一律用 ASCII 名（分支名不受影响，炸点只在目录路径）。
- **边界**：`.env` 等 dotfile 只是不列出，`/api/files` 预览围栏本就放行整个 cwd（现状未收紧，与行内路径可开任意 cwd 文件一致）；chat 无 badge 入口（代码路径未浏览器验，条件分支 trivial）；子目录展开状态在刷新后不保留（v1 取舍）。
- **收尾追记（同 session）**：feature commit `3a64f4b` → merge main `ace43e3`（progress 双 S51 撞号，本条重编为 S53；sessionStore 与 S52 thinking 改动自动合并，tsc ✓）→ main `make build` ✓（`/api/sessions/[id]/files` 注册）→ prod kickstart（/login 200、API 401 闸正常）。两个中文 worktree 已 `git worktree move` 到 ASCII：`trellis-fix-chat-mode`（原 修复-CHAT-模式问题，移时干净）/ `trellis-workspace-files`（原 增加工作区目录；旧路径留了同名 symlink 保当时会话存活，**确认没有旧会话锚着后可删**）。均未 push。
- **返工（同日用户反馈「没看到这功能」）**：入口藏在 ModeBadge（状态徽章暗藏可点、视觉零变化）不可发现——连用户都找不到即判不及格。改为 **Header 独立 📁 按钮**（仅有 workspacePath 的会话显示，与笔记按钮同级），ModeBadge 回退纯展示。fix `c9f5682` 已 merge main；隔离实例实测：workspace 会话按钮显示+抽屉正常、chat 会话无按钮。**未重启 prod**——当时另一并行 session 正在 main 工作区活跃开发（Composer/LinearThreadView 有未提交 WIP + 刚重建的 .next，20:41 的 build 已含本 fix），避免替其上线未验证代码；其下次 kickstart 自动带上。
- **Next**: 用户真机验收（尤其手机远程取件场景）；push 由用户定。

### Session 52 (2026-07-15)
- **Done**: **CHAT 模式"假死"修复（thinking 可视化 + effort env 卫生，roadmap D4 解锁）**。根因两层：claude CLI 2.x **默认**先出 thinking 块再出正文（实测 haiku 无任何 effort env 也 thinking），而 SDK/trellis 只透传 `text_delta`、thinking 全丢——UI 对一条一等输出通道结构性失明；叠加 `CLAUDE_CODE_EFFORT_LEVEL=max` 从 occ alias 启动的 shell 穿透进 trellis 进程（SDK streamLines 用 `{...process.env, ...opts.env}` spawn），思考期拉到分钟级把症状放大成"卡死"。
  - **SDK 侧**（~/sdk，dist 已重建）：`EventType.Thinking` + ClaudeBackend 映射 `thinking_delta`→Thinking 事件；纯增量，CLIRunner switch 有 default→null，self-agent 无感。
  - **trellis 链路**：`StreamEvent`/`ProviderEvent`/`RunEvent` 加 `thinking`；run-bus `committedThinking` 累计（**不落 DB**，ephemeral 与 CLI 折叠一致）+ catchup 带 `thinking` 快照（仅 streaming 时）；SSE 两路由泛转发零改动；store 把 thinking 发到 stream-bus 新 `thinkingChannel(nodeId)`（created/done/error/catchup 同步清理）。
  - **UI**：TurnCard 思考面板——无正文时 dim 面板"思考中…"+ 思考文本流式跟尾（auto-scroll），正文开始后折叠成 `<details>`"🧠 思考过程（N 字）"，done 后整体消失；画布 ChatNode 加 DOM-direct"思考中…"指示器（零 React 重渲染纪律不破）。
  - **env 卫生**：`instrumentation.ts` 启动时 scrub `CLAUDE_CODE_EFFORT_LEVEL` 并 console.warn（trellis 的 effort 由自己决定=CLI 默认；将来 per-session effort 走 RunOptions.env 显式下发）。
- **验证**（tsc ✓；隔离实例 :3123 + 临时 DB + 真 claude）：scrub 启动 log ✓；SSE `created→thinking→delta→done`（haiku thinking×6/×17）✓；浏览器（agent-browser + MutationObserver）：TurnCard 面板流式更新（sawThinking=39）+ 折叠态（sawPanel=11）+ done 后消失 ✓、画布指示器 ✓、思考期中途刷新重连恢复面板 ✓。另实测：endpoints.yaml 的 `claude:claude-sonnet-5`/`claude-fable-5` 简单问题不产 thinking（模型自主决定，SSE 无 thinking 事件属正常），legacy `claude-haiku` 稳定 thinking。测试产物全清（server/临时 DB/ASCII 验证 worktree/11 个孤儿 chat-scratch jsonl 核 0 引用后删）。
- **坑（环境）**: 本 worktree 目录名含中文 → Turbopack `make build` 崩（`start byte index not a char boundary`，asset ident 切 CJK 字节边界）——与改动无关；已在 ASCII 临时 worktree 套同改动 build ✓。**后续 worktree 目录用 ASCII 名**。
- **Next**: 用户验收后 commit（连同 Session 51 的 anchor 改动一并）；候选 follow-up：codex reasoning 事件同样透传、ModelPicker 对 catalog 外 legacy id（claude-haiku）的显示回退优化。

### Session 51 (2026-07-15)
- **Done**: **线性视图 anchor 跳转改为对齐卡片头**。树缩略图/分支卡/搜索等触发 `setActiveNode` 后的滚动定位从 `scrollIntoView block:"center"` 改为 `block:"start"`（`LinearThreadView.tsx` anchor effect）+ 卡片 `scroll-mt-3` 留呼吸空间——长卡片居中会落在回答中段，看不到卡片头的 #编号和用户提问。
- **验证**: tsc ✓；隔离实例（快照 DB + dev :3004 + agent-browser）实测：p2p 会话线性视图点缩略图根节点→视口顶=「#1 · Turn」+提问；点长卡片节点 #8（DHT 长文）→视口顶=卡片头+分叉 banner+提问，不再落中段。测试产物已清。
- **注**: 本 worktree bun install 装 `file:` @sm 两包同 Session 49 的 ENOENT，已手动 symlink 修复（同 `make relink-sdk` 效果）。
- **Next**: 用户验收后 commit。

### Session 50 (2026-07-15)
- **Done**: **临时文件上传（Stage 19 落地，形态调整为 composer 附件）**。动机：远程操作时快速给 agent 补充文件+上下文（CSV/日志/PDF 等截图之外的东西）。核心设计：**复用 Stage 15 blob 基座零 schema 变更**（`attachments_json` 原样，kind 由 mime 推断），通用文件**不进 provider vision 通道**——tool-capable 模式（workspace/project/chat增强，全是 `--dangerously-skip-permissions`）spawn 前物化到 `~/.trellis/uploads/<nodeId>/<原文件名>` + prompt 末尾注入绝对路径清单，agent 自己 Read/Bash 消费（CSV 能现场跑分析）；纯 chat 文本类 ≤128KB 内联 fenced block、二进制 UI 拦 + 服务端 prompt 注明。`~/sdk` 零改动、codex 路径零改动。
  - 新 `lib/attachments.ts`（客户端/服务端共享 ext↔mime 白名单 ~35 种 + 分类 helpers）；`blobs.ts` 泛化（storeBlob 按 ext、resolveBlobPath 全表、`materializeAttachments` 幂等 staging→retry 免费复用、`readTextBlob`）；uploads POST 收通用文件（multipart 必带文件名，ext 白名单 + 服务端钦定 canonical mime 防浏览器 junk mime）、GET 加 `?name=` Content-Disposition；chat route images/files 分流 + `questionForTopic` 隔离（内联大 CSV 不污染 topic label）。
  - 前端：新 `hooks/useAttachmentUploads.ts` 抽掉 QuestionInput/BranchPopover 各 ~80 行重复（顺手修多文件拖入 stale length 超上限），policy 感知（纯 chat=图+文本，tool-capable=全量）；AttachmentPreview 非图片渲染文件 chip（图标+文件名+大小，readonly 点击开 `?name=` URL），`PendingAttachment` 加 mime。
- **Merge 注记**：feature 在 `goby` 分支基于旧结构开发（旧 LinearComposer/QuestionBlock），merge 时撞上 Session 47 的统一阅读面重构——LinearThreadView 冲突**整体取 main 版**，附件能力改移植进新共享 `Composer.tsx`（线性+画布 DockedComposer 一处接线，比旧结构更收敛）；TurnCard 已自带 readonly AttachmentPreview，文件 chip 自动生效。
- **验证**（合并前 goby 侧：隔离 dev 3099 + 临时 DB + 真 claude haiku 全链路）：curl 上传 csv（含 junk mime→canonical）/415 拦截/Content-Disposition/图片 raw 回归全过；**workspace 真 claude 带 CSV → Read staging 路径 → 答对 3 行、均值 86.33**；纯 chat 内联答对 bob=92（无 tool call）；纯 chat PDF → 模型正确告知换模式；**retry 删 staging 后幂等重建再答对**；project 两轮 resume 不断链（turn2 答对 carol=79）；agent-browser 实测选文件→chip→发送→答对 + PDF 拦截提示。合并后 main 侧：tsc ✓ + `make build` ✓ + Composer 移植点浏览器 smoke（见 merge commit）。测试产物全清。
- **边界**：export.ts 不动（图片附件本也不导出，保持一致）；staging/blob GC 沿用 P2 决策；文件路径只注入当轮 prompt 不回灌折叠历史（与图片对齐）。
- **Next**: 用户真机（手机远程）验收。commit 均 `--no-gpg-sign`（1P 签名 agent 当时拒签，同 3b61a2e 待补签）。

### Session 49 (2026-07-15)
- **Done**: **「空白沙箱」workspace——Project/Workspace 模式不挑目录，一键随机开一个空白上下文的空目录当 cwd**。新 `POST /api/workspaces/scratch`：在 `~/.trellis/scratch/<adj-animal-NN>`（与 `lib/paths.ts` 的 CHAT_SCRATCH 同族约定）非递归 mkdir，slug 碰撞（EEXIST）自动重试；WorkspacePicker header 下方加「✨ 空白沙箱」快捷入口（两个 tab 都可见，创建中禁用 + 失败行内报错），拿到路径走既有 `pickPath`。下游（session 创建/spawn cwd/文件预览围栏/最近列表）零改动——就是一个普通 workspace path，basename=slug 在「最近」里可读。
- **验证**: 本 worktree（barnacle）首次 bootstrap：`make setup` 中 bun 装 `file:` 的 @sm 两包报 ENOENT，但 `make relink-sdk` 本来就会重建软链，补跑后 `make check` 全绿（这个失败对 setup 无实质影响）。`tsc --noEmit` ✓、`make build` ✓（`/api/workspaces/scratch` 注册）。隔离 dev server（:3097 + 临时 DB）runtime 验证：POST ×2 产出两个独立空目录；**真 claude 全链路**：用 scratch 目录建 project session（haiku）→ SSE created/delta/done 正常、答 PONG!、jsonl 落在 `~/.claude/projects/-Users-smokingmouse--trellis-scratch-<slug>/`。测试产物（server/临时 DB/两个 scratch 目录/claude projects 目录）已全清。
- **Caveat**: 未浏览器实测 picker 按钮的视觉/交互（按逻辑写，emerald 虚线卡片风格对齐现有 UI）。scratch 目录不自动回收——删 trellis session 不删目录（目录是空的或只有用户要的产物，倾向保守不动；若堆积成噪音再加清理策略）。
- **Next**: 浏览器实测「✨ 空白沙箱」入口。已合并回 main。

### Session 48 (2026-07-15)
- **Done**: **线性视图滚动已读**（用户反馈「不从画布点进去不算已读」）。根因：`LinearThreadView` 的已读逻辑沿用旧全屏阅读器契约——只对 anchor（active 节点）计 1s 停留，整条 thread 里滚动读过的卡片全漏标。改为 IntersectionObserver 视口级判定：卡片 ≥50% 可见（或超屏长卡占视口 ≥50%）持续 1s → `markNodeRead`；离开视口取消计时（快速滚过不算读）；`nodes` 变化时对可见卡补判（streaming 结束停在屏内的场景，observer 不再触发）；observer 随 `session?.id` 重建，卡片卸载时 unobserve + 清计时器。原 anchor 专属 effect 删除（被视口判定覆盖——anchor 会滚到视口中央）。仅改 `components/LinearThreadView.tsx`。
- **验证**: tsc ✓ + `make build` ✓（npm run build 会因 bun:sqlite 失败，必须 make/bun）。浏览器实测（快照 DB + 隔离 `next start` :3111 + auth env 置空关闸 + agent-browser，真实 DB 零触碰）：「web3 实践」7 未读基线 → 主链滚动阅读后链上 2 个未读被标 ✓；折叠在「↳ 1 个分支」后的另一条 lineage 5 个未读**不**被误标 ✓；点分支卡切 lineage 再滚 → 全部标已读，minimap 12 点全灰 ✓。
- **Next**: ① ~~commit~~ 已合入 main（`51d7dff` + merge，免签，同 3b61a2e 待补签）；② 体感调参候选：1s 停留阈值 / 50% 可见阈值；③ 未 push。

### Session 47 (2026-07-14)
- **Done**: **GitHub issue #2-#7 全部落地**（用户指令「把所有的 issue 都做了」）。核心 = issue #7 架构统一（决策 → decisions.md 2026-07-14「统一阅读面」），#2/#4 随之关闭；#3/#5/#6 独立修：
  - **#5 卡死**：`QuestionInput` 提交后 `streamRoot(...).finally(setBusy(false))` 复位；store 加 `streamAlert` + 新 `StreamAlertToast`（底部居中，8s 自动消失）；`handleStreamEvent` error 分支放宽——created 前失败（fetch 拒绝/非 2xx）不再静默丢弃，回收乐观占位 + 弹全局 toast。
  - **#6 乐观渲染 + 锁底**：store 新 `insertOptimisticNode`/`discardOptimisticNode`（`optimistic-*` id，导出 `isOptimisticNodeId`）；`streamBranch` 与 `streamRoot(attach)` 提交瞬间插占位卡（问题 + 生成中 dots），`created` 删占位换真 id（active/lastEdited 同步迁移）；abort/reconnect/ViewState 持久化对 optimistic id 全部设防；finally 兜底回收（SSE 掉线 pre-created）。`LinearThreadView` 流式期间 rAF 锁底（slack 120px，上滚暂停、回底恢复；锚点居中滚动让位于流式 tip）。
  - **#7 统一阅读面（含 #2/#4）**：新 `components/TurnCard.tsx`（NodeFullView 全能力迁入：可编辑 QuestionBlock、marks 注入——`hooks/useMarkdownBodyMarks.ts` 独立成 hook、再答一版/卡片图/复制/CLI resume 操作行、ReferenceFullBody、InteractionForm、GeneratedFilesBar）；`LinearThreadView` 全模式化（mode 标签、⌘K 选区分叉复用 BranchPopover、⌘D 摘笔记、B 键回父锚点、锚点节点 1s 标记已读、节点删除入口、sticky Composer 直接聊）。删 `NodeFullView.tsx`（1345 行）+ `NodeTreeOverlay.tsx`；store `fullScreen`/`setFullScreen` 移除，`setViewMode("canvas")` 接管「回画布 pan 到最新节点」；入口迁移：ChatNode/ReferenceCard 卡片点击与「阅读」钮、DoneToast、jumpToNoteSource、jumpToSearchHit → 线性+锚定；ViewState 兼容迁移（旧 fullScreen=true → linear）；移动端改「进 session 默认线性」。
  - **#3 画布固定底部输入区**：新共享 `components/Composer.tsx`（textarea 与流式停止钮等高 44px 零跳动；乐观窗口内停止钮「连接中…」禁用）；Canvas 加 `DockedComposer`（fixed bottom，目标 = active 节点，「回复 #N」目标 chip）；AddNodeFAB 上移 bottom-24 避让。
- **验证**：`tsc --noEmit` ✓、`make build` ✓（唯一 warning 为已知 @sm/llm NFT trace）。浏览器实测（快照 DB → `TRELLIS_DB_PATH` 隔离 `next start` :3003 + cookie 过闸 + agent-browser，真实 DB 零触碰）：① project 会话默认线性 + TurnCard 操作行全在；② chat 会话画布 + DockedComposer「回复 #26」chip + 「线性」toggle；③ chat 线性 8 卡 + minimap；④ mock 发送 + 注入 800ms fetch 延迟实锤乐观窗口（占位卡 ~849ms 内以 `optimistic-` id 存在、created 后换真 id）、流式逐帧采样全程锁底、完成后无占位残留；⑤ /api/chat 强制 500：toast「发送失败：HTTP 500」+ 占位回收 + composer 存活；⑥ 首屏同法：按钮从「提交中…」恢复、textarea 可用、输入保留、toast 显示（原 bug 三点全修）；⑦ 首屏正常路径回归（mock 新会话 → canvas）；⑧ 画布点卡 → 线性锚定；⑨ 线性选区 → BranchPopover + 摘到笔记。顺带回归 Session 46 锁系（codex 会话内 claude 系全置灰）。**prod 注意**：本轮 `make build` 替换了 `.next`，已 `launchctl kickstart -k` 重启 com.smokingmouse.trellis（3088：/login 200 + API 200）；3001 上另有 Jul 13 起的手动旧实例未动（内存里旧 build，异常可自行杀）。
- **返工修复（同日用户反馈）**：线性视图内容不足一屏时输入框跟在内容后「悬在半空」——`sticky bottom-0` 只在内容超出滚动区时生效。改为视口绑定 flex 三段布局（`fixed inset-0 flex flex-col`：header shrink-0 / 滚动区 flex-1 / composer shrink-0 恒贴底）。实测：1 节点短会话 composer 距视口底 12px（=内边距）✓；长会话（10 卡）滚动/锚点自动滚动/锁底回归 ✓。prod 已再次 kickstart。
- **未实测项**：移动端（pointer:coarse）默认线性只过了代码路径；线性视图长 reference 全文渲染（无折叠）体感待反馈。
- **Next**: ① ~~commit + close~~ 已完成（`3b61a2e` + `6d40985` push，issue #2-#7 自动关闭）；② deferred：命令面板参数补全、Stage 18-22；③ 移动端线性实机体感待反馈。

### Session 46 (2026-07-14)
- **Done**: **Session 锁系 + codex 系内多模型**（决策 → decisions.md 2026-07-14）。触发：用户定方向「codex 不能二等公民；真实需求 = 开局选系 + 系内切换，跨系中途切是伪需求」。改动 5 文件，硬约束=不破坏 claude 既有功能：
  - `lib/llm/providers.ts`：`providerFamily` 认 `codex:*` 前缀（全链路 family 语义——run-bus/repo/chat route 的 resume 列选择、权限协议闸、attached 限制全部经此函数，一处改全局对齐）；新增 `blockedFamilySwitch(current,next)`（双方∈{claude,codex} 且不同才拦，mock 豁免）+ `FAMILY_LABELS`；`contextWindowFor` codex: 前缀 → 400k。
  - `lib/llm/server.ts`：default 分支前插 `codex:*` → `makeCodexProvider({mode, model: slug})`（CodexBackend 既有 `-m` 透传，`codex.ts` 一行未改）；裸 `codex` case 原样保留。
  - `app/api/providers/route.ts`：新增 `codexProviders()`——读 `~/.codex/models_cache.json`（codex CLI 自维护缓存），`visibility==='list'` → `codex:<slug>` 条目；cache 不可读回退单条裸 `codex`（兼容无 codex 机器）；裸 `codex` 恒保留（存量 session model='codex' 的 picker 显示依赖精确 id 查找）。
  - `components/ModelPicker.tsx`：按 family 分组渲染（Claude 系/Codex 系/调试 组头）；session 活跃时 `blockedFamilySwitch(provider, p.id)` 的条目 disabled + 副标题「跨系 · 需新会话」；无 session（首屏）全部可选。
  - `lib/commands.ts` + `QuestionInput.tsx`：CommandStore 加 `provider`；`/model` 同规则拦截（返回「跨系请 /new 开新会话」note）。注：QuestionInput 仅 `!session` 时渲染，故此闸当前为纵深防御，session 内实际执法点=ModelPicker（唯一切模入口）。
- **验证**（tsc ✓ + build ✓ + 快照 DB 隔离 `next start` :3003 真 spawn + agent-browser，prod 全程未动）：`/api/providers` 27 条（claude 系 18 + codex 系 8 + mock），codex 7 模型枚举正确；**真 spawn 三路全通**：`codex:gpt-5.4-mini`（真 GPT 回复，证明 `-m` 生效+family 路由正确）/ 原生 `claude:claude-sonnet-5` / `deepseek:deepseek-v4-flash` 回归无恙；`sessions.model` 复合 codex id 落库+重开采纳（header 显示 gpt-5.4-mini）；UI：codex 会话内 claude 系 18 条全灰、codex 系内切换（4-mini→5.5）即生效、claude 会话内 codex 系 8 条全灰（对称）、mock 两侧均可选、首屏全部可选+分组头正常。测试产物在快照 DB 随 /tmp 清除，真实 DB 零触碰。
- **Done（续）**: **agent-gateway 残留三清**（用户拍板"完全清掉"）：① `node_modules/agent-gateway` 孤儿目录删除（不在 package.json/bun.lock，bun 不自动清理）；② `sdk-adapter.ts` 两处过时注释改指 `@sm/agent`；③ 本地仓库 `~/python/agent-gateway` 删除——删前核实：工作区干净、main 已推送、唯一无 upstream 分支 `feat/chat-bfork-context` 的 commit 已全部含于 origin/main、无其他项目引用；远端 `github.com:SmokingMouse/agent-gateway` 保留为归档。tsc ✓。trellis 现在**完全依赖 sm-toolkit（~/sdk）**，agent-gateway 时代正式落幕。
- **Next**: ① commit（用户确认后）；② codex parity P0 = native resume（需实测 `codex exec resume`/rollout jsonl 行为）+ 能力矩阵；③ P1 = codex 树分叉前缀 rollout 可行性 spike。

### Session 45 (2026-07-14)
- **Done**: **工作区收敛 + 积压浏览器验收一轮清完**。① 6 个本地分支（feat/cli-session-sync、llm-sdk-migration、feat/chat-bfork-context、fix/mobile-and-cleanup、fix/mobile-session-drawer、linear-inline-compose）确认全部 0 commits ahead of main 后删除；main push（`9add18d..1345c51`，5 commits）。② 浏览器验收（快照 `~/.trellis/data.db` → `TRELLIS_DB_PATH` 隔离 + 现成 prod build `next start` 3003 + 关 auth + agent-browser，prod 3001 全程未动）：
  - **线性视图四项全过**（真实「web3 实践」12 节点 1 分叉）：project 默认 linear、「↳ 1 个分支」展开 + 分支卡点击切 active lineage（thread 内容 + 缩略图 active 点同步变）、缩略图 12 圆点点击跳任意节点（thread 自动滚到位）、画布↔线性往返保 active。画布侧顺验：大纲平铺仅分叉子带 ↳（S43 修复在生效）、节点无重叠。
  - **/model 动态 catalog 全过**：`GET /api/providers` 20 条（claude 4 档 + deepseek×2 + ark-coding×12 + codex/mock，gemini 正确排除）；ModelPicker 下拉渲染动态 catalog + 点选即切（header 同步）；`/model deepseek:deepseek-v4-flash` 命令本地执行不发 LLM、header 即切、输入框清空。**置灰路径本机不可测**——当前 endpoints.yaml 所有条目 `hasKey:true`，无 false 样本。
  - **Session 工作台全过**：命令面板 `/` 下拉列 /new /clear /archive /model /switch；/switch 打开 SearchModal（mode facet + FTS 高亮命中正常）；归档往返（行内 🗄 → 已归档计数 2→3 → 恢复 → 刷新后持久）；SessionTabs 预览 tab + 双击固定 + 双 tab + ⌘1 快切；`/api/runs` 返回 `{runningSessionIds:[]}` 正确。
- **遗留小项（非阻塞）**：① 命令面板输入参数后（如 `/model deep`）下拉整个收起，无模型名补全——`matchCommands` 只配命令名，参数补全未做，UX 可后补；② `/new` `/clear` `/archive` 三命令未逐个实跑（同一 registry 分流路径，/model /switch 已证通路）；③ 移动端未在本轮范围。
- **Next**: 等用户定方向：roadmap Stage 18-22（Skill 入口已有 C4 版 / 文件附件二进制 / Plan 节点 / Memory 桥接读侧 / Subagent 可视化）或 deferred（Level B store 重构、per-session model）。

### Session 44 (2026-07-11)
- **Done**: **全局 LLM 模型选择接入（结合 `~/sdk`/sm_toolkit 的 endpoints.yaml），并连带把死掉的 `agent-gateway` 依赖迁移彻底解决**。触发：模型选择原来硬编码三档（claude-opus/sonnet/haiku + codex）；调研发现 trellis 依赖的 `agent-gateway`（`file:../../agent-gateway`）本机已缺失、`node_modules` 未装，app 实际处于装不起来的状态。拍板方向：不修复对 agent-gateway 的依赖，而是把它的能力整体拆开摊平进 `~/sdk` 的 `@sm/agent`（agent-gateway 仓库退役），trellis 只依赖 `~/sdk`。
  - `~/sdk`（`@sm/llm`/`@sm/agent`）侧的改动详见 `~/sdk/progress/README.md` 2026-07-11 session（含 self-agent 生产 bot 的零改动兼容验证）。
  - trellis 侧：`package.json` 从 `agent-gateway` 换成 `@sm/agent`+`@sm/llm`(`file:` 绝对路径指到 `~/sdk/packages/*`)；`next.config.ts` 的 `turbopack.root` 挪到 `$HOME`（覆盖 trellis 和 `~/sdk` 两处 symlink 目标）、`serverExternalPackages` 同步换名。`lib/llm/claude.ts`/`codex.ts`/`sdk-adapter.ts` 只换 import 源，不需要自己再解析 endpoint/拼 env——这个能力已经内置进 `@sm/agent` 的 `ClaudeBackend`。`lib/llm/providers.ts` 的 `ProviderId` 从闭合联合放宽成 `string`，`isProviderId` 降级为结构校验（真正校验在服务端解析时抛错）；`providers.ts`/`server.ts` 的 switch 收敛成 `mock`/`codex`/`default→claude`。新增 `GET /api/providers`：读 endpoints.yaml，过滤掉只有 `openai_url`（协议不兼容 claude CLI 壳，如 gemini）的条目，映射成 `"<provider>:<model>"` 复合 id，服务端专属（密钥/YAML 访问不出服务端）。`stores/sessionStore.ts` 加 `providerCatalog` 状态 + hydrate 时 fetch；`ModelPicker.tsx`/`lib/commands.ts` 的 `/model` 命令改吃动态 catalog（`hasKey===false` 置灰不可选）。
  - **踩坑&修复**：`/api/providers` 最初把原生 claude 条目的 `hasKey` 也按 `api_key_env`(`ANTHROPIC_API_KEY`) 判定，误报 false——原生 claude 走 `claude login` OAuth 不需要这个 env var，实测验证「hasKey:false 但真实可用」后修正：无 override URL 的原生条目一律 `hasKey:true`。
  - **验证**（隔离 dev server 3099 + 真实 spawn，全部走真实 `/api/chat` HTTP 全链路，非直调 provider 函数）：`GET /api/providers` 返回 claude 三档 + `deepseek:*`(2) + `ark-coding:*`(12) + codex/mock，gemini 正确排除；chat 模式选 `deepseek:deepseek-v4-flash` 真实发消息拿到真回复；chat 模式选原生 `claude-opus` 回归不受影响；**workspace 模式 + 第三方模型 + 真实 Bash 工具调用**全链路成功（`--add-dir`+`--dangerously-skip-permissions`+ env 覆盖三者叠加正确）；project 模式两轮对话验证 `--resume` 在第三方端点下正确复用 session（第二轮 cache_read≈18.8k，与第一轮总 context 量级吻合，证明 resume 命中同一 CLI session，未被模型换了就断链）；codex 路径完全不受影响（真实回复）；`sessions.model` DB 全量往返正确（含 legacy `claude-opus`/`codex` 与新 `deepseek:deepseek-v4-flash` 复合 id）。**测试数据已清理**（5 个测试 session 通过 `DELETE /api/sessions/[id]` 移除，未触碰其余 30 个真实用户 session）。
  - `npx tsc --noEmit` ✓、`npm run build` ✓（`/api/providers` 路由已注册，仅一条关于 `@sm/llm` 动态 fs 路径的 Turbopack NFT trace 警告，无害）。
- **Caveat**: `onCanUseTool` 交互式工具协议（AskUserQuestion/ExitPlanMode 表单）在第三方模型下未专门用真实交互场景触发验证，但 workspace 模式下的真实 Bash tool_call 已间接证明该协议在第三方端点下能正常收发（`--permission-prompt-tool stdio` 是 CLI 本地机制，不依赖远端模型侧的特殊支持）。`/model` 命令面板的动态 catalog resolve 只过了 tsc/build，未浏览器实测交互手感。
- **Next**: 浏览器实测 `/model` 命令面板动态 catalog + ModelPicker 置灰交互；若要收尾 agent-gateway 独立仓库（留着不维护 vs 删除）是用户的决定，本轮不动。

- **Done（同日续，合并进 main）**: 上面全是在 npm 分支（旧 `agent-gateway` file: 依赖已损坏）上做的，`git merge main` 时发现 **main 早已独立完成 bun 迁移**（`better-sqlite3`→`bun:sqlite`、删 `package-lock.json`、`agent-gateway` 改 `github:` 引用可直接装）——两条线互不知情地各自"修好了 agent-gateway 问题"，用不同手段。拍板方案：改成 bun 跟main对齐，不留 npm/bun 双版本。合并冲突（`package.json`/`next.config.ts`/`README.md`）手动逐一解决，`progress/README.md` 自动合并无冲突。
  - **两个 bun 特有的坑，均已修复并固化进 `Makefile`（`relink-sdk` target + `--bun` flag），非一次性手工绕过**：
    1. **bun 的 `file:` 依赖不是单层软链**（npm 那样），而是给依赖目录本身建**真实目录**、目录内**每个文件单独软链**回源。Turbopack 生产构建的 package.json 解析器吃不下这种结构（`Error: package.json is not parseable: invalid JSON: a redirect can't be parsed as json`），跟 `turbopack.root` 设多宽无关（窄/宽两种都试过，都复现）。修法：`bun install` 后用 `make relink-sdk`（内联在 `make setup` 里）把 `node_modules/@sm/{agent,llm}` 换成单层目录软链（跟 npm 产物同形），问题消失。**这条 Verified Fact 对任何未来往 trellis 加 `file:` 依赖的场景都成立**，不是本次特例。
    2. **`bun run dev/build/start` 不会让 Next/Turbopack 内部 spawn 的 worker 进程也跑在 bun 运行时下**，导致 `lib/server/sqlite.ts` 的 `bun:sqlite`（bun 内置模块）在 worker 里解析不到而崩。必须用 `bun --bun run ...`（`--bun` 强制递归子进程也走 bun runtime）。`Makefile` 的 `dev`/`build`/`start` target 已经这么写。
    3. （顺手验证过、非 bug）家目录下有个无关的旧 `~/package-lock.json`（大概率某次误在 home 目录跑过 `npm init`）——一度怀疑是 Turbopack root 自动推断选错根的原因，实测确认**不是**（挪走/放回结果一样），Turbopack 的自动推断仍不可靠，所以显式钉 `turbopack.root` 是必须的，不是可选优化。
  - **验证**：`rm -rf node_modules .next && make setup` 全自动跑通（clone/pull `~/sdk` → build → 装依赖 → relink → 前置检查全绿）；`make build` 全量过；`make dev` 起服务后 `curl /api/providers` + 真实 `deepseek:deepseek-v4-flash` chat 消息全走通（`bun --bun` 下 `bun:sqlite` 正常）。测试 session 已删。
  - **Commit**：`~/sdk` 在 `main` 直接提交（无分支问题）；trellis 在 `SmokingMouse/goosefish` 上先 checkpoint 提交 npm 版本，再 `git merge main` 解冲突改 bun，尚未 fast-forward `main`/push（用户要求先不 push，本地完成即可）。

### Session 43 (2026-06-17)
- **用户反馈**: 画布节点重叠 + 长线性 project 聊天的大纲「层层缩进楼梯」别扭（project 基本线性，树是过度抽象）。选了交互方向 **C·线性 thread 主视图 + 树缩略图**（分两增量做）。
- **Done（增量 1：两个 bug，已浏览器验）**:
  - **大纲缩进按「分叉深度」而非「轮数」**（`Outline.tsx`）：TreeRow 用 `branchDepth`(=祖先分叉点数) 取代 `depth`，子代仅当父 >1 子才 +1；`↳` 仅分叉子显示。线性段全平铺。
  - **画布重叠修**（`layout.ts`）：compact 模式原固定 90px 且忽略实测高度，但 streaming/error 节点仍渲染 600px 全卡（`ChatNode: showCompact=isCompact&&!streaming&&!error`）→ 被当 90px 摆放压住下方。改为 compact 下当实测高度 >90 时按实测留位（保持普通 compact 卡统一打包）。
  - **验证**: tsc ✓；快照 DB 起隔离 dev server + agent-browser 实测真实「Analyze WeChat」会话(24 轮纯线性)：大纲 50 行**全 paddingLeft=4px 平铺**(原会得楼梯到 ~600px)；画布 25 节点 **0 重叠**。环境/快照已清。
- **Done（增量 2：线性 thread 主视图 + 树缩略图，待浏览器验）**:
  - Store 加 `viewMode: "canvas"|"linear"` + `setViewMode`；`loadSessionInternal`/新建 session 路径按 mode 初始化（project→linear，其余→canvas），`ViewState` 持久化扩 `viewMode` 且兼容旧数据。
  - 新 `LinearThreadView`：active 锚点算 root→tip 线性 thread（祖先反转 + active + 最小 `siblingIndex` 子链），逐轮渲染问题/markdown 回答/工具调用/CLI 续聊/复制；非主线子节点折成「↳N 个分支」并可切 active lineage。
  - 新 `ThreadMinimap`：复用 `layoutNodes(nodes, undefined, {compact:true})` 画右下角 SVG 树，点圆点 `setActiveNode`，可折叠；无第二个 React Flow。
  - `app/page.tsx` 仅 `project && viewMode==="linear"` 走线性视图；否则保持原 `fullScreen ? NodeFullView : Canvas`，project canvas 增「线性」切换钮；移动端 project 不再被启动 effect 强制 fullscreen。
  - **验证**: `npx tsc --noEmit` ✓；`npm run build` ✓；grep 自检 viewMode 默认/持久化、thread 计算、分叉条件、minimap 点击、page project-only 分流均符合 spec。
- **Next**: 用户浏览器实测真实 project 会话：默认线性、画布往返、缩略图点击、分叉展开切 lineage。

### Session 42 (2026-06-17)
- **Done**: **「在 CLI 继续」轻量入口**（project 会话本就是真 claude CLI 会话，给可粘贴的续聊命令）。`cli-fork.ts` 加 `cliResumeForNode(nodeId)`：project 模式下，attached(cli-import) 取该节点 lineage sid（验源 jsonl 在盘）、native 走 `getRootResumeIdForNode`（自带 jsonl 存在性自愈），返回 `{cwd, resumeId}`，非 project/缺盘→null。新 `GET /api/nodes/[id]/cli-resume` 返回 `{resumable, command}`（`cd '<ws>' && claude --resume <id>`，cwd 单引号转义）。新 `CliResumeButton`（仅 project 模式渲染，点击 fetch+复制命令，不可续显「盘上找不到」）挂 NodeFullView 动作行。续到的是该 lineage 主链 tip（树内分叉的「CLI 续任意分支」需 P2 前缀 jsonl，本入口不含——已记 spec）。
- **验证**: tsc ✓ + `npm run build` ✓（`/api/nodes/[id]/cli-resume` 注册）。隔离 dev server 实测：attach 真会话 → `GET cli-resume` root 返回正确 `cd … && claude --resume <sid>`、坏节点 `resumable:false`；真跑生成的命令 `claude --resume` 被接受（无 "No conversation found"）。环境/产物全清。
- **架构注记**: 用户问「一棵树本质是多 session id，为啥 CLI 只能加载主链」——答：①「新提问」根=独立 claude session，今天就各自可 resume；② 一个 session 内的分叉是 in-jsonl fork，`claude --resume` 只跟主线性叶子（claude CLI 把会话当线性消费，非数据限制，且 claude CLI 非我方代码）；③ 破法=把分叉物化成独立 session（= P2 的 fork-session/前缀 jsonl 引擎）。本轮选轻量档（只续 lineage tip）；「CLI 续任意分支」= 推广 P2 到 native，留作后续。
- **Next**: 按需把「续任意分支」做全（推广 buildPrefixJsonl 到 native project）；或 merge。

### Session 41 (2026-06-17)
- **Done**: **CLI 分支对齐 P2b：trellis→CLI 分叉接线 + 真 claude 端到端验**。`/api/chat/route.ts` 加 `resolvedOrigin`（branch 取 parentSession.origin），resume 解析在 `origin==='cli-import' && kind==='branch' && family==='claude'` 时走 attached lineage：`attachedLineageForNode(X)` → 若 X 是其 lineage jsonl tip 且 trellis 无其他子（`hasOtherChild`）→ 线性 `--resume <lineageSid>`；否则 `buildPrefixJsonl(X)` 在 X 构造前缀 jsonl → `registerForkLineage` 插 `cli_lineages` 新 fork 行 → `setNodeResumeId(新节点, newSid)` → `--resume <newSid>`。两路 `forkSession=false`、`sessionIdTarget=undefined`（id 自管，不写 root）。`cli-fork.ts` 加 `hasOtherChild`/`registerForkLineage`。原生 chat/workspace/project resume 与 `getRootResumeIdForNode` 零改。
- **验证（真 claude 闭环，翻盘性未知已打掉）**: 造真会话 2 轮（haiku，turn1 记暗号「香蕉」→turn2 记「苹果」，21 行 jsonl）→ 临时 DB attach（2 turn 导入）→ `buildPrefixJsonl(turn1)` 产 9 行前缀（含香蕉 3 处、含苹果 0、旧 sid 残留 0）→ 真 `claude --resume <newSid> -p "记住过哪些暗号"` 答「**只记得香蕉**，无法回溯其他 session」。证明 trellis 程序化构造的前缀 jsonl 可被真 claude 从任意历史节点 X 续上、且上下文严格截到 X（不含被砍的后续轮）。`npm run build` ✓（Compiled successfully）+ `tsc --noEmit` ✓。测试产物（含 `~/.claude/projects/-private-tmp-p2b-claude-test`、临时 DB、tsx 脚本）已全清。
- **HTTP 全链路 e2e（隔离 dev server localhost:3099 + 临时 DB + 关 auth + 真 claude，已验收通过）**: 造真会话 turn1=A=7→turn2=B=99 → `POST /api/cli-sync/attach`（2 turn 导入）→ `POST /api/chat {kind:branch, parentNodeId:turn1}`（**从历史非 tip 节点分叉**）→ SSE created/delta/done，分叉答「**A=7**」（不知被截掉的 B=99）→ reconcile 后 DB：新 fork 节点挂 turn1 下、`claude_session_id`=新 fork lineage（≠root）、临时流式节点已删、`cli_lineages` 新增 `is_root=0 fork_point=turn1` 行。turn1 现有两子（原 B=99 + 新分叉）分属不同 lineage = 真分叉子树。环境/测试产物全清。
- **Next**: 按需 commit/merge `feat/cli-session-sync`（P1+P2 全链路已验，含真 claude e2e）。可选：真实浏览器 UI 眼验分叉子树渲染（功能链路已确证，纯视觉确认）。

### Session 40 (2026-06-16)
- **Done**: **CLI 分支对齐 P2a：trellis→CLI 分叉地基**。`cli-import-db.ts` 的 union import 记录 turn 首引入 lineage，节点 `claude_session_id` 从“仅 root”放宽为“每节点所属 lineage sid”；unchanged 快路径会检测旧节点 sid 是否已补齐，避免既有 attached 会话因游标命中而跳过迁移。新增 `lib/server/cli-fork.ts`：`attachedLineageForNode(nodeId)` 返回 lineage sid/source jsonl/tip 状态；`buildPrefixJsonl(branchFromNodeId)` 读取源 jsonl，按 parser 同款 turn ownership 找 X turn 末条 assistant，沿 parentUuid 保留 root→X uuid 链 + X 前无 uuid 元数据，改写每行 sessionId 为 newSid，uuid/parentUuid 不动并写同目录 `<newSid>.jsonl`。顺手给 `deleteNodeSubtree` 加 `origin!='cli-import'` jsonl cleanup 闸，避免 per-node sid 让 attached 子树删除误删用户 CLI jsonl。
- **边界**: 未改 `cli-import.ts` 解析器内核，未改 `/api/chat/route.ts` / run-bus，未碰原生 chat/workspace/project resume 逻辑；P2b 仍需真 claude 验证程序化 prefix resume。
- **验证**: `npx tsc --noEmit --pretty false` ✓；P2a 一次性 fixture（脚本已删除，`/tmp/p2a.db` + fixture dir 已清）✓：per-node sid 正确；`attachedLineageForNode` 对 tip/非 tip/root/fork 返回正确；`buildPrefixJsonl(n2)` 产物只含 root→n2，sessionId 全改 newSid，uuid 不变，无孤儿 tool_use，`parseCliSessionJsonl` 得到 turns `n1,n2` 且 tip=`n2`；P1 回归 root+fork union=5 节点、forkC reimport=6 节点、detach 保留 jsonl；`npm run build` ✓。
- **环境说明**: 契约指定的 `npx --yes tsx --conditions=react-server` 在本沙箱因 `tsx` 未安装且 npx 网络受限会卡住；`~/.claude/projects/__p2a_verify__` 也因写权限被沙箱拒绝。实际验证用本地 jiti runner 显式 alias `server-only` empty + `/tmp/__p2a_verify__` 跑同一 fixture 逻辑。
- **Next**: P2b 接线：仅 `session.origin==='cli-import'` 时在 `/api/chat` 选择 attached lineage，tip 线性续聊继续用 lineage sid，分叉调用 `buildPrefixJsonl` 后插 `cli_lineages` 新 fork 行并用真 claude `--resume <newSid>` 闸验。

### Session 39 (2026-06-16)
- **Done**: **CLI 分支对齐 P1：union 导入 + lineage 发现 + watcher 新 fork 检测**。`sqlite.ts` 新增 `TRELLIS_DB_PATH` 测试覆盖 + `cli_lineages` 表/既有 attached 无损迁移；`cli-discover.ts` 新增 `discoverLineage`（同目录 jsonl 按共享 turn uuid union-find，picker attached 排除改查 lineage 全集）；`cli-import-db.ts` 改为 `importCliLineage(sessionId)`，读取 lineage 全组按 uuid upsert 到同一 trellis session、跨 jsonl 重算 siblingIndex、每 lineage 独立 `synced_uuid`，且仅 root 节点保留 `claude_session_id`；`cli-sync-watcher.ts` attach 改 discover+seed+union import，watch 改 per-lineage，未知 jsonl 与 attached 组共享 uuid 时自动插入新 fork 后重导。`reconcileAttachedTurn` 改为对整组 lineage 重导并按 union newest turn 对账。
- **边界**: 未改解析器 `cli-import.ts`，未碰 `getRootResumeIdForNode` / `repo.ts` SessionRow / `lib/types.ts` Session，detach 继续由 `origin='cli-import'` 闸保护原始 jsonl。
- **验证**: `npx tsc --noEmit --pretty false` ✓；legacy migration smoke ✓（既有 `cli-import` session 补成 root lineage 且搬 `synced_uuid`）；一次性 fixture 脚本（已删除，临时 DB/jsonl 已清）✓：rootA+forkB attach 后 `cli_lineages=2`、节点 `{n1,n2,n3,n5,n6}` 不重复；forkC 新文件 `reimport` 后 `cli_lineages=3`、`n7.parentId=n2`、siblingIndex 无冲突；`detachSession(rootA)` 后 session/nodes/lineage 全清且 3 个 fixture jsonl 仍存在；`npm run build` ✓。
- **Next**: P2 另起：trellis 分叉写回 CLI fork-session/前缀 jsonl，并重新定义 resume 目标定位；本轮不继续扩边界。

### Session 38 (2026-06-16)
- **Done**: 修两处用户反馈。① **CLI attach 同步不再依赖刷新**:新增 `lib/server/cli-sync-events.ts` process 内 pub/sub + `GET /api/cli-sync/events` SSE(route 首帧 ping + 30s keepalive),`cli-sync-watcher` 在 import 状态为 imported/updated 时广播 `session_updated`;新增 `hooks/useCliSyncEvents.ts` 挂到 `app/page.tsx`,收到当前 session 更新就 `loadSession`,非当前 session 只 bump `sessionsRevision` 让列表更新。客户端 SSE 掉线 2s 重连,服务端发送失败会清理 subscriber。
- **Done**: ② **context 占用旧数据修正**:确认 live Claude/Codex 链路已带 `contextTokens` 并落 `token_context`;DB 抽样显示 `native|project` 旧节点大量 `token_context=NULL`,回退旧口径会虚高 3x-10x。新增 `lib/server/context-backfill.ts` 在 instrumentation 启动时 best-effort 回填:仅填 `origin='native'` project root 下 `token_context IS NULL` 的 done QA 节点,优先按当前 Claude cwd 编码找 jsonl,找不到则在 `~/.claude/projects` 按 session id 兼容搜索,按 root subtree created_at 顺序映射 parsed turns 的 `contextTokens`。不改成本四桶/正文/状态。顺手补齐 `stores/sessionStore.ts` 的 SSE `done.usage.contextTokens` 类型。
- **验证**: `npm run build` ✓。临时 dev server `localhost:3099` 启动 ✓;`/api/cli-sync/events` 带 auth cookie curl 收到首帧 `data: {"type":"ping"}` ✓。DB 实测 backfill 跑后 `native|project` 空 context 从 30 → 28;剩余 28 个旧节点对应的原始 Claude jsonl 不在本机 `~/.claude/projects` 或无可匹配源,无法可靠恢复,仍按 Header 旧口径回退。
- **Next**: 浏览器验收 attach 会话:外部 CLI 新增一轮后当前 Trellis 页面应自动刷新出新节点;若用户需要“外部 CLI 生成中的逐 token 流式”,需另做 tail jsonl/PTY 级方案(当前 jsonl mirror 只能在文件落盘时同步)。

### Session 37 (2026-06-09)
- **Done**: **文件预览围栏从「cwd 内」放宽到「session 实际碰过的范围」+ 重写 HTML 内 file:// 链接（build ✓ + curl + agent-browser 实测真实案例）**。触发:用户的 `~/design-loop-demo/compare.html`(4 版对比面板,链到 naive/cand-a/cand-b/looped.html + shots/*.png)预览不了——文件全在 cwd(`~/.claude`)外,旧围栏只服务 cwd。用户拍板最完整方案,并要求「能预览所有它生成的文件**包括子 agent 生成的**,但保证安全」。
  - **新围栏模型**(`lib/server/workspace-files.ts` 重写):`resolveSessionFile(sessionId, absPath)` + `sessionAllow(sessionId)`——白名单 = workspace cwd ∪ {session 所有 nodes 的 Write/Edit tool_calls 的 file_path 父目录}。**目录级放行**是覆盖「子 agent 生成的兄弟文件」的关键:主 agent Write 了 `design-loop-demo/looped.html` → 整个 `design-loop-demo/` 放行 → 子 agent/脚本写的 compare.html/naive.html/shots/*.png 全可预览。**安全**:`isBroadDir` 把 $HOME 本身 / 顶层系统根 / depth≤1 判为 broad,这类父目录只放行**单个文件**(不暴露整个 home);全程 realpath(symlink/firmlink 归一)+ containment。
  - **URL 方案改成绝对路径**:`/api/files/<sid>/<完整绝对路径去前导/>`(原 workspace-relative)。这样 HTML 相对资源(`./naive.html`/`shots/x.png`)**天然解析正确**(URL path 镜像真实目录结构),且重写后的链接一致。`filePreviewUrl(sid, absPath)`/store `filePreview.path`/`openFilePreview(absPath)` 全链路改绝对路径;客户端 `previewablePath`(原 pathInWorkspace)绝对路径直通、相对路径 join workspace、`~/` 跳过;chip 列**所有** Write 文件(不再按 cwd 预筛,服务端兜底)。
  - **file:// 重写**(route):服务 `text/html` 时读进内存,把 `(href|src)="file://(/...)"` 正则重写成 `/api/files/<sid>/...`(直接 file:// 导航在 http 页/sandbox iframe 被拦)。非 HTML 仍流式。
- **验证**: `npm run build` ✓。**curl 实测**(真实 ee30f329 session):compare.html/looped.html/naive.html(子 agent 兄弟)→**200**;`~/.zshrc`(home broad 未碰)→**404**;`/etc/passwd`→**404**;相对链接 `naive.html`→200、`shots/cand-a.png`→200(子目录 dir 白名单覆盖)。**agent-browser 实测**:① 直接渲染 compare.html→**4 版网格 + 截图全加载** ② 节点行内路径(相对 `skills/…eval-compare.html`)渲染靛蓝可点 → 点击 → **全局 overlay → iframe 渲染对比面板**(含内嵌 SVG/图)。安全守住 + 子 agent 产物可见 + 内部链接可跳,全达成。
- **Caveat**: 围栏走 tool_calls,故只认主 agent 工具调用记录过的目录/文件(子 agent 内部 Write 不冒泡到顶层 tool_calls,靠「父目录放行」间接覆盖——主 agent 没碰过的全新目录里的子 agent 产物仍够不着);`~/` 开头的行内路径客户端展不开 home → 不可点(绝对/相对正常);sessionAllow 每请求遍历 nodes(HTML 多资源时多次,未缓存,够用)。
- **Next**: 回 session-workbench Wave 1-4 积压的 UI 实测,或等用户新指令。

### Session 36 (2026-06-09)
- **Done**: **文件预览入口升级——回答里像路径的行内代码直接可点（build ✓ + agent-browser 实测全过）**。用户提议:别只靠 tool_calls 抽 chip,默认让回答正文里像文件路径的都能点、点完渲染。比 chip 更通用(解耦文件来源:Write/Bash 生成、引用提到的都覆盖)。
  - **架构:FilePreview 升级为 store 驱动的全局 overlay**。store 加 `filePreview:{relPath,name}|null` + `openFilePreview(relPath)`/`closeFilePreview`;`FilePreview` 改无 props、从 store 读、page.tsx 顶层挂一次(像 SearchModal/NotesDrawer)。所有入口(chip / 行内路径 / 未来文件浏览器)调同一个 action,预览那半完全复用。
  - **行内路径检测**:`lib/generated-files.ts` 新 `pathInWorkspace(text, ws)`——严格降误判:必须含 `/` 分隔符(根目录裸文件名走 chip 不行内,避免 `config.py` 误判)+ 已知扩展名(`PREVIEWABLE_EXT`)+ 非 URL + 能 resolve 进 workspace(复用 `relativeToWorkspace` 含 /private firmlink 归一)。`lib/md-components.ts` 加 `code` 组件:行内且命中 `pathInWorkspace` → 渲染靛蓝虚线下划线可点 button(`openFilePreview`),否则原样 `<code>`;block code 不动(仍走 `pre`→CodeBlock)。用 `useSessionStore.getState()`(非 hook,读稳定值)。
  - **chip 保留**:`GeneratedFilesBar` 改调 `openFilePreview`(去本地 FilePreview + active 态),和行内路径统一走全局 overlay。两入口并存(chip 抓 Bash 生成但正文没提的;行内抓正文提到的)。
- **验证**: `npm run build` ✓ + **agent-browser 实测**(隔离 project session,Claude Write `assets/page.html` 到子目录 + 回复行内引用):① `assets/page.html`(带 `/`)渲染成**靛蓝可点**、点击→全局 overlay→**iframe 渲染青色渐变 HTML** ✓ ② 同行 `#00c6ff → #0072ff`(非路径)保持**玫红普通 code 不可点** ✓(误判控制住)③ 底部 chip「🌐 page.html」并存、点击同样开预览 ✓ ④ Esc 关闭 ✓。测后清理 session+文件。
- **Caveat**: 行内仅认含 `/` 的路径(根目录裸文件名只走 chip);`~/` 前缀路径客户端无法展开 home → 不可点(绝对/相对路径正常);路径不存在→点了 404(纯语法判定,客户端无法 stat)。`getState()` 非响应式,但回答随 session 变更整体重渲染,够新。
- **Next**: 回 session-workbench Wave 1-4 积压的 UI 实测,或等用户新指令。

### Session 35 (2026-06-09)
- **Done**: **B — token/context 占用计算修正（跨 2 包全链路 + 运行时实测，build ✓）**。Session 34 已证 claude `result.usage` 是跨工具迭代/同模型 subagent 的**累计和**，被当成「当前 context 占用」→ 虚高数倍。本轮落地修正：报**末条 assistant message 的 usage**（=主 agent 当前窗口实际占用）作为独立口径。
  - **agent-gateway**（`../../agent-gateway`）：`events.ts` Cost 加 `contextTokens: number|null`；`backends.ts` claude 分支流式中 `let lastAssistantContext`，每条 `t==="assistant"` 用 `msg.usage` 覆盖更新（input+cache_read+cache_creation），result 直报 `contextTokens: lastAssistantContext`（异常退回累计）；codex 设 `totalIn`（单轮无累计问题）；其余 5 处 Cost 构造（image×2/gemini/api/mock）补 `null`。`npm run build`(tsc) emit dist（注：gemini.ts:73 有**预存在**无关 TS error，noEmitOnError 未设仍 emit；未碰）。
  - **trellis 全链路**：`lib/llm/types.ts` TokenUsage +`contextTokens?`；`sdk-adapter` Result→done 映射；`run-bus` 3 处 inline usage 形状 + 初始化器 +`contextTokens`，finalizeNode 传 `tokenContext`；`sqlite.ts` nodes 加 `token_context INTEGER`（可空，幂等 ALTER）；`repo.ts` finalizeNode 写列 + NodeRow/NODE_COLS/rowToNode/ApiNode.tokenCount + resetNodeForRetry 置 NULL；`lib/types.ts` ChatNode.tokenCount +`contextTokens?`；store done 处理 `tokenCount: usage` 自动带（apiNodeToChatNode 全展开，reload 路径通）；`Header.tsx` 新 `ctxTokensOf(n)`（优先 contextTokens，null 回退 input+cache 旧口径）替换 findLatestCtxTurn + ctx 计算。
  - **设计**：contextTokens 作 TokenUsage 第 5 个可选字段贯穿（而非到处加新参数），最小化触点；与四桶累计（成本口径）并存——成本仍看累计，占用%看 contextTokens。null = legacy/codex/非 claude → 回退旧口径，无破坏。
- **验证**: `npm run build` ✓（trellis 端到端）。**运行时实测**（`backend.run` 直跑 2 工具 prompt）：累计 sum=**150,209**（旧口径，占 200k 窗 75%）vs contextTokens=**50,178**（新口径，~25%），**虚高 2.99x** — 修正生效。
- **Caveat**: DB `token_context` 持久化是 mirror 既有 token 列 + build 验证，**未单独跑 project-mode 落库往返**（逻辑等价于 cache 列，风险低）。Header% 在有 contextTokens 的新数据上准确；老节点 null→回退旧口径（仍偏高，但无新数据可补，可接受）。
- **Done (续) — 本地文件预览（workspace/project 生成的文件/HTML 在 Trellis 内直接看，build ✓ + curl 实测围栏）**。用户痛点:生成的文件 or HTML 看不到、得折腾去文件系统。用户拍板:**自动列出本轮生成/改动的文件 chip + HTML 走 sandbox iframe 渲染**。
  - **服务端**:新 `lib/server/workspace-files.ts` `resolveWorkspaceFile(sessionId, relPath)`——`getSessionWorkspacePath` 取 cwd,**realpath 双重围栏**(root realpath + target realpath + startsWith,防 `../`/符号链接逃逸),扩展名→mime 表。新 path-based 路由 `GET /api/files/[session]/[...path]`(path-based 而非 query,让生成 HTML 的相对资源 `./style.css` 能解析),`fs.createReadStream→Response`,`Cache-Control: no-store`。
  - **客户端**:`lib/generated-files.ts`:`generatedFilesFromNode`(从 toolCalls 抽 Write/Edit/MultiEdit/NotebookEdit 的 file_path)、`relativeToWorkspace`(剥 workspace 前缀)、`filePreviewUrl`、`previewKind`(html/image/pdf/markdown/text)。`components/FilePreview.tsx`:全屏 overlay(createPortal 逃 transform 祖先,Esc 关),按 kind 分发——**html→sandbox iframe**(`allow-scripts allow-popups allow-forms`,**无 allow-same-origin**=opaque origin 跑 JS 但碰不到父/cookie)、image→img(棋盘底)、pdf→iframe、markdown→ReactMarkdown 复用 MD_COMPONENTS、text→fetch 文本 `<pre>`(>500k 截断)。`components/GeneratedFilesBar.tsx`:从 store 读 session,只列 workspace 内文件 chip(带 kind icon),点开 FilePreview。挂在 NodeFullView 回答动作行下方。
  - **设计**:文件来源 = tool calls 的 file_path(零额外存储,精确对应"这轮生成");只读、只服务 workspace 内、HTML opaque-origin sandbox —— 三重边界。
  - **验证**: `npm run build` ✓。**curl 实测**:workspace 内 CLAUDE.md→200 text/markdown 8696B;编码 `../` 逃逸→404;`../../etc/passwd`→404;不存在→404;chat session(无 workspace)→404。**围栏稳固**。UI(chip 显示/点开/iframe 渲染)未浏览器实测。
- **Caveat (文件预览)**: Bash 间接生成的文件不在 chip 内(只认 Write/Edit 类 tool);文件须在 workspace 内才显 chip(外部写按安全边界不预览);iframe `allow-scripts` 无 same-origin → 用 localStorage/同源 fetch 的页面受限(MVP 取舍,多数 dashboard/svg 自包含 OK)。
- **Done (续2) — agent-browser 浏览器实测全过 + 抓修一个真 bug**。逐项眼验:
  - **B context%**: 旧节点显 39%(token_context=NULL→回退旧口径);**新写入节点显 5.1%**(走新 contextTokens 口径,单轮 write ~5% 合理) — 新口径在真实新数据上生效。
  - **C 划线追问**: 程序化选区 + 派发 pointerup,3 字符→**不弹** bar、15 字符→**弹** bar(`针对「…」`) — 8 字符门槛 + 释放才提交都对。
  - **D 卡片图**: 直接 DOM click 触发完整序列 `卡片图→生成中…→✓已下载→复位`(headless 无 clipboard 权限→按设计降级下载;toBlob 成功=PNG 生成 OK,真实浏览器会复制图片)。
  - **文件预览(全链路)**: 建隔离 project session(/tmp)→Claude `Write` 写 dashboard.html→chip「🌐 dashboard.html」显示→点击→**FilePreview sandbox iframe 实时渲染**(紫渐变 Dashboard+按钮)→Esc 关闭。
  - **per-session model 顺带验**: 切到的 chat session 显 Codex、project session 显 Claude,各保各的模型(Session 34 A 生效)。
  - **★ 抓到真 bug(build/curl 都看不出)**: macOS `/tmp` 是 `/private/tmp` 的 firmlink,Claude `Write` 报 realpath `/private/tmp/...` 而 session workspace 存的是 `/tmp/...`,`relativeToWorkspace` 朴素前缀匹配失败→**chip 不显**。修:`canonical()` 归一化 `/private/(tmp|var|etc)` firmlink 后再前缀匹配。修后 chip 正常。production build ✓。(真实用户 session 多在 /Users 下不踩此坑,但 /tmp·/var workspace 会,值得修。)
- **Next**: 三件「修复吧」(per-session model / token / 文件预览)+ C/D 全部落地并浏览器验收。回 session-workbench Wave 1-4 积压的 UI 实测,或等用户新指令。

### Session 34 (2026-06-09)
- **Done**: 三件用户提的修复（build ✓ ×N，A 另过 curl 实测）+ 一个基础设施根治。
  - **A — 模型 per-session 锁定（修「切回来模型变了」）**。原 `provider`（=ProviderId，即模型 claude-opus/sonnet/haiku/codex）纯全局（localStorage `trellis-provider`），切 session 不变 → 误用。全链路落库：`sqlite.ts` 加 `sessions.model TEXT`（幂等 ALTER，镜像 system_prompt）；`repo.ts` ApiSession/SessionRow/SESSION_COLS/rowToSession + `createSessionWithRoot` 落 model + 新 `setSessionModel`；`/api/chat` 建 session 时存 `model:providerId`；`PATCH /api/sessions/[id]` 加 `{model}` 分支（isProviderId 校验）；`lib/types.ts` Session.model；**store 核心**：`loadSessionInternal` 把 `provider` 设成该 session 的 model（legacy null 不动），`setProvider` 改 model 时 PATCH 持久化到当前 session（全局值降级为「新 session 默认」）。**curl 实测**：PATCH model=codex→200+持久化、切回 claude-opus、非法值 400、rename 回归 ✓。
  - **C — 划线追问太易触发**。根因 `useMobileSelection`（NodeFullView.tsx）对任意非空选区触发 + 每 300ms 轮询 + selectionchange 持续触发。改成：只在**手势释放**（pointerup/touchend/keyup）提交、**最小选区 8 字符**（`MIN_SELECTION_LEN`）、去掉轮询，selectionchange 仅用于「选区塌缩则关闭」。
  - **D — 去掉「存到记忆」，改「卡片图+复制剪贴板」**。删 NodeFullView 内联 `MemorySaveButton`（定义+挂载）；新 `components/CardImageButton.tsx`：把问答（问题=标题 + 回答正文，复用 md-body+MD_COMPONENTS 保持渲染一致）渲染到屏外卡片 → `html-to-image` toBlob PNG → `navigator.clipboard.write([ClipboardItem image/png])`，不支持则降级下载。新依赖 `html-to-image@1.11.13`。用户确认：PNG 图片 + 卡片放「问题+回答」。
  - **基础设施根治 — agent-gateway symlink 在 Turbopack 解析失败**。`npm install html-to-image` 把 node_modules 里原本的 agent-gateway **真实拷贝换成 symlink**（指向项目根外 `../../agent-gateway`），Turbopack 不跟进项目外 symlink → `Module not found: agent-gateway`（Node 能解析、Turbopack 不能；serverExternalPackages 也含它）。根治：`next.config.ts` 加 `turbopack.root = path.join(__dirname,"..","..")` 指到 monorepo 父目录，symlink target 落入 root → 解析通过。**从此 npm install 的自然 symlink 无害**，且 B 改 agent-gateway 重 build 后经 symlink 自动反映。
- **验证**: `npm run build` ✓（端到端，含 A/C/D + turbopack root）。A 经 dev server curl 往返实测。**C/D 未浏览器实测**——C 的手势手感（释放才弹/8 字符门槛/拖动中不弹）、D 的剪贴板 PNG 写入（ClipboardItem image/png，localhost 安全上下文）+ 卡片 light/dark 渲染，均按逻辑写未眼验。
- **Caveat**: html-to-image 安装一度连带破坏 package-lock 的 agent-gateway resolved 字段，已 `git checkout` 还原 + 重新规范化（现 lock 一致、html-to-image 正式声明）。
- **Next**: **B（token/context 计算）未做**——这是另一半「修复吧」。实测已证：claude `result.usage` 是跨迭代/同模型子 agent 的**累计和**（5 轮工具循环报 ~150k，真实窗口仅 ~50k，虚高 3x），而非主 agent 当前 context。修法在 agent-gateway `backends.ts`：流式中追踪**最后一条 assistant message 的 usage** 作为「当前 context 占用」单独报（与累计成本分开），trellis sdk-adapter/types/store/Header 接新字段。turbopack root 已铺好 agent-gateway 编辑路。之后浏览器实测 C/D。

### Session 33 (2026-06-09)
- **Done**: **Session 重开恢复「上次浏览位置」（build ✓）**。痛点:打开/切换 session 时 `loadSessionInternal` 把 `activeNodeId` 重置为 `null`——桌面落在画布全景、手机/全屏 fallback 到 `rootNodeId`(最老节点),从不回到上次离开的地方。用户拍板语义:**记住上次离开时所在的节点 + 连视图层(画布/全屏)一起还原**。
  - **持久化 helper**(`stores/sessionStore.ts`):新 `VIEW_KEY`/`loadViewState`/`persistViewState`,存 `{activeNodeId, fullScreen}` 到 **localStorage**(`trellis-view:<sid>`,选 localStorage 而非 collapsed 的 sessionStorage——要跨 reload/重启存活)。
  - **恢复**(`loadSessionInternal`):读 saved view,校验节点仍存在(被删则回退 canvas 无焦点),`fullScreen` 仅在有有效节点时还原;并 un-collapse 还原节点的祖先(复用 `ancestorsOf`)保证画布可见。原子 set() 一次写入 `activeNodeId`+`fullScreen`。
  - **写入**:模块级 `useSessionStore.subscribe` 监听 `(session.id, activeNodeId, fullScreen)` 变化即 `persistViewState`——一处覆盖所有散落写点(focus/jump/search/键盘导航/全屏切换),mutation 站点零改动。loadSessionInternal 原子 seed → 切换后首次 fire 只是幂等重写。
- **验证**: `npm run build` ✓ + Compiled successfully。逻辑走查:cold start 走 hydrate→loadSessionInternal 自动恢复;切 session 同链路;collapsed=sessionStorage 冷启为空→还原节点必可见。
- **Caveat**: **未浏览器实测**——(a)桌面还原全屏层、(b)切换 session 视图层跟随、(c)被删节点回退 canvas、(d)祖先折叠时自动展开,四条按逻辑写未眼验。mobile 仍被 page.tsx:58 强制 fullScreen(符合移动端定位,activeNodeId 已正确还原所以全屏看的是对的节点)。
- **Next**: 浏览器实测重开恢复全链路(桌面画布/全屏跟随 + 切换 + 删节点回退)。回 Wave 2/3/4 积压的 UI 实测。

### Session 32 (2026-06-09)
- **Done**: **A 路第③刀(最后一刀,纯前端)— 把模型交互请求渲染成表单(build ✓)**。后端①②(store 镜像 `node.pendingInteraction` + SSE `interaction_required/resolved` + `POST /api/nodes/[id]/respond`)已完成,本刀只读 `pendingInteraction` + 调 respond API,不碰后端。
  - **store action `respondToInteraction(nodeId, toolUseId, decision)`**(`stores/sessionStore.ts`):POST respond API,**乐观清除** pendingInteraction(`interaction_resolved` 也会清,幂等)。失败分层:404/409=stale(保持清除,UI 提示"会话已失效")、400/5xx/网络=retryable(还原表单可重试)。返回判别结果 `{ok:true}|{ok:false;reason:"stale"|"error"}` 给组件渲染反馈。提交前 guard:pending 不存在或 toolUseId 不匹配直接判 stale。
  - **新组件 `components/InteractionForm.tsx`**:按 toolName 分发。AskUserQuestion → 每问一卡(header 小标签 + question 标题 + options),单选 radio 圆点/多选 checkbox 方框,选中 indigo 高亮,全部答完才能提交;构造 `answers` map(单选 = label string、多选 = label[])→ allow + `updatedInput:{...input,answers}`。ExitPlanMode → 复用 NodeFullView 同套 MD_COMPONENTS+remark/rehype 渲染 `input.plan`,两键「✅ 批准执行」(allow)/「✋ 拒绝」(deny,可选 textarea 填理由 → message)。醒目 indigo 容器 + 「🙋 模型在等你回答」标题,dark mode 全配。
  - **挂载**:NodeFullView `<ResponseBody>` 下方,`node.pendingInteraction` 非空时渲染 `<InteractionForm>`。
  - **画布徽章**:ChatNode 全卡(amber「🙋 待你回答」banner)+ 紧凑概览卡(🙋 amber pill),让用户从画布就看到待答节点。
- **验证**: `npm run build` ✓ + TypeScript ✓。grep 自检全过:respondToInteraction 接 `/api/nodes/${nodeId}/respond`;InteractionForm 按 pendingInteraction 在 NodeFullView 挂载;ChatNode 两处徽章接上;answers 单选 `chosen[0]`(string)/多选 `chosen`(array)构造正确;ExitPlanMode allow/deny 双键接对。
- **Caveat**: **未浏览器实测**——尤其(a)多选交互手感(toggle 累加/取消)、(b)失效态(404/409 stale 提示 + retryable 还原)两条失败路径,均按逻辑写但未真触发后端验证;(c)dark mode 配色、提交中 loading/禁用、表单随 pendingInteraction 清除而消失,均靠现有 Tailwind 习惯未眼验。
- **Next**: 浏览器实测 A 路③全链路(AskUserQuestion 单/多选 + ExitPlanMode 批准/拒绝 + 失效态 + 画布徽章)。

（Session 1–31 已归档，见 `archive.md`）
