# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | kind: codex | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。


目标：体验优化五件：飞书机器人富文本卡片、Linux 终端 ttyd 自愈、卡片图导出修复、侧栏与结构面板右键菜单、侧栏嵌套树+链（实现全走 gemini 3.8，review 异源 codex）
- [ ] lark-card: 飞书机器人回复改为 Schema 2.0 互动卡片（markdown 富文本 + 图片 image_key），抄 happyclaw 的卡片构建器 | seat: gemini | keep-seat
  cid: fj-lark-card-6374
  verify: bunx tsc --noEmit
  verify: bun test
  交付物：lib/server/lark/ 下新增 card.ts（markdown → 飞书互动卡片 JSON，schema 2.0）与 card.test.ts；sdk.ts 的发送路径从 msg_type "text" 切到 msg_type "interactive"（content = JSON.stringify(card)），thread 模式的 reply_in_thread 语义保持；卡片发送失败（飞书回非 0 code）降级回现有 markdownToLarkText 的纯文本路径并打日志，不丢消息。
  参考实现（直接抄结构，不要从零设计）：/Users/smokingmouse/python/ai/happyclaw/src/feishu.ts 约 990 行起「Build a Feishu interactive card (Schema 2.0) from markdown text」、feishu-cards/builder.ts（schema '2.0' 的卡片骨架）、feishu-markdown-style.ts（飞书 markdown 方言：标题 / 列表 / 代码块 / 表格 / 链接哪些能渲染、哪些要转义）、feishu-cards/length.ts（卡片长度上限与截断策略）。只搬「markdown → 卡片 JSON」这一层，不搬它的 streaming card / outbox / 多租户。
  图片：markdown 里的 ![alt](src) —— src 为本机绝对路径或 http(s) URL 时，通过飞书 im/v1/images（image_type=message）上传拿 image_key，卡片里用 img 元素（点击可预览大图）；上传失败时该图退化为文字「[图片] alt」+ 链接，其余内容照发。上传函数放 sdk.ts，参考 happyclaw feishu.ts 约 3539 行「Step 1: Upload image to Feishu to get image_key」。
  现有代码位置：lib/server/lark/sdk.ts（第 67-90 行附近是现在发 text 的地方）、lib/server/lark/protocol.ts 的 markdownToLarkText（保留作降级）、lib/server/lark/handler.ts 第 379 / 390 / 420 / 479 行是四处发送调用点（都要走卡片）、lib/server/lark/push.ts taskLarkMarkdown（定时任务推送，同样走卡片）。
  单测（card.test.ts，bun test）至少覆盖：标题 / 有序无序列表 / 行内代码 / 围栏代码块 / 表格 / 链接各一例的卡片 JSON 形状；超长文本按 length 策略截断、不切坏代码块围栏、尾部带「详情见 Trellis 会话」链接；含图片的 markdown 在上传成功 / 失败两种桩下的输出；空文本给「（Agent 未返回文本）」。
  不做：入站图片消息的处理（handler.ts 第 420 行「暂只支持文本」不动）；卡片按钮 / 回调；流式更新卡片。
  【通用约束】worktree 基线 = main HEAD；开工前确认 node_modules 已装（setup_cmd 已跑 bun install，没装就自己跑）。验收：bunx tsc --noEmit 0 错、bun test 全绿（基线 317 pass）、bun --bun run build 通过。注释与界面文案用中文，风格跟随所在文件。不动 .fenjue/**、不 push、不 make deploy、不碰 ~/.trellis/data.db（只允许 sqlite3 .backup 出副本）。完成后 git commit（只 add 自己改的路径），用契约里的 fj mail send result 汇报，artifacts 列改动文件与新测试。需要起隔离实例验证时照 scripts/mobile-verify/mobile-read-later.sh 的配方（真库副本 + 独立 HOME + TRELLIS_LARK=off + 独立端口 + agent-browser），本地 curl 加 --noproxy "*"，用完把实例停掉。
- [ ] ttyd-linux: Linux 上 Web 终端「未找到 ttyd」自愈：扩探测路径 + 环境变量覆盖 + 一键下载静态二进制 + 平台正确的安装提示 | seat: gemini | keep-seat
  cid: fj-ttyd-linux-ca8b
  verify: bunx tsc --noEmit
  verify: bun test
  现象：Linux（systemd user unit 跑的实例）终端面板报「终端不可用：未找到 ttyd（安装：apt install ttyd）」。两个已知事实：① progress/facts.md 第 22 行——debian bookworm 的 apt 根本没有 ttyd 包，GitHub release 的静态二进制（ttyd.x86_64 / ttyd.aarch64，1.7.7）可用；② systemd 下 PATH 只有 /usr/local/bin:/usr/bin:/bin，装在 ~/.local/bin 的也找不到。
  交付物：
  1. lib/ttyd-dependency.ts：候选路径加 $TRELLIS_TTYD_BIN（环境变量，最高优先）、~/.trellis/bin/ttyd、~/.local/bin/ttyd、/snap/bin/ttyd；tmux 同样加 $TRELLIS_TMUX_BIN、~/.local/bin/tmux（lib/server/ttyd.ts 第 31 行 TMUX_CANDIDATES）。installHint 按平台给对的话：darwin 仍是 brew install ttyd；linux 改成「点击下方『自动安装』或手动下载静态二进制到 ~/.trellis/bin/ttyd」并附完整 curl 命令（含 chmod +x）。
  2. lib/server/ttyd-install.ts：installTtyd() —— 仅 linux 生效；按 process.arch 映射 release 资产（x64 → ttyd.x86_64，arm64 → ttyd.aarch64，其余报不支持）；版本钉死 1.7.7，sha256 钉死在代码里（你自己从 https://github.com/tsl0922/ttyd/releases/tag/1.7.7 的 SHA256SUMS 或实下载计算后填入，注释里写来源）；下载到临时文件 → 校验 sha256 不符则删除并报错 → chmod 755 → 原子 rename 到 ~/.trellis/bin/ttyd → 重新探测并返回 ProbeResult；fetch 遵守 https_proxy / HTTPS_PROXY 环境变量；任何失败都返回可读的原因与手动命令，不留下半截文件。
  3. app/api/terminals/install/route.ts：POST，调用 installTtyd，返回 { ok, path, tried, error }；同一时间只允许一个安装在进行（并发第二次返回 409）；鉴权与现有 app/api/terminals/route.ts 同口径。
  4. components/TerminalPanel.tsx：错误态在「重试」旁加「自动安装 ttyd」按钮（仅当服务端报告 platform=linux 时显示；服务端在探测结果里带上 platform 与 arch），点击后显示进度 / 结果，成功即自动重试拉终端；「探测详情」列出全部尝试过的路径（包括环境变量与新候选）。
  5. 单测：lib/ttyd-dependency.test.ts（伪造 HOME / PATH / TRELLIS_TTYD_BIN，断言候选顺序与探测详情文案）；lib/server/ttyd-install.test.ts（用桩 fetch：arch 映射、sha 不符时目标文件不存在、成功时文件可执行且返回路径、不支持的 arch 报错）。测试不得访问网络。
  约束：lib/ttyd-dependency.ts 不能引入 server-only（server.ts 纯 bun 进程也用它）；不要改 ttyd 的启动参数与端口逻辑（lib/server/ttyd.ts 的登记 / 收尸机制是 S77-S82 反复修过的，别碰）；mac 上行为零变化。
  【通用约束】worktree 基线 = main HEAD；开工前确认 node_modules 已装（setup_cmd 已跑 bun install，没装就自己跑）。验收：bunx tsc --noEmit 0 错、bun test 全绿（基线 317 pass）、bun --bun run build 通过。注释与界面文案用中文，风格跟随所在文件。不动 .fenjue/**、不 push、不 make deploy、不碰 ~/.trellis/data.db（只允许 sqlite3 .backup 出副本）。完成后 git commit（只 add 自己改的路径），用契约里的 fj mail send result 汇报，artifacts 列改动文件与新测试。需要起隔离实例验证时照 scripts/mobile-verify/mobile-read-later.sh 的配方（真库副本 + 独立 HOME + TRELLIS_LARK=off + 独立端口 + agent-browser），本地 curl 加 --noproxy "*"，用完把实例停掉。
- [ ] card-image: 修「卡片图」导出失败：先复现拿根因证据再修，参考 happyclaw 的 ShareImageDialog | seat: gemini | keep-seat
  cid: fj-card-image-8404
  verify: bunx tsc --noEmit
  verify: bun test
  现象：用户点回答卡片上的「卡片图」按钮（components/CardImageButton.tsx：html-to-image 把这轮问答渲染成 PNG 后弹预览让用户复制 / 下载）会失败（进入 error 态或图空白）。
  第一步先复现，不要凭猜修：起隔离实例（真库副本）用 agent-browser 打开一个有真实回答的会话点「卡片图」，把浏览器 console 报错与结果截图存到 out/；分别试含代码块 / 含图片 / 含 KaTeX 公式 / 含 mermaid 的回答各一例，记录哪些失败、报什么。常见根因候选（逐个证实或排除）：跨域样式表让 html-to-image 读 cssRules 抛错、字体内联失败、跨域图片污染 canvas、foreignObject 在 WebKit 上的限制、卡片尺寸超 canvas 上限、CSP 拦 data: / blob:。
  参考实现：/Users/smokingmouse/python/ai/happyclaw/web/src/components/chat/ShareImageDialog.tsx（同样用 html-to-image 的 toCanvas，注意它对字体、图片、iOS、重试与 dataURL 下载的处理）与 web/src/utils/download.ts。把它证明有效的做法搬过来（例如 toCanvas 参数、skipFonts / fontEmbedCSS、图片跨域处理、pixelRatio、iOS 分支），不要整体替换成别的库。
  交付物：CardImageButton.tsx 修复；out/repro.md 写清复现步骤、根因证据（console 原文）、修法；修后同一批用例全部出图并把成功截图放 out/；若有纯函数逻辑（如样式过滤、尺寸计算）抽到 lib/ 并配 bun 单测。桌面与手机壳都要验证（手机侧若有入口一并验）。
  【通用约束】worktree 基线 = main HEAD；开工前确认 node_modules 已装（setup_cmd 已跑 bun install，没装就自己跑）。验收：bunx tsc --noEmit 0 错、bun test 全绿（基线 317 pass）、bun --bun run build 通过。注释与界面文案用中文，风格跟随所在文件。不动 .fenjue/**、不 push、不 make deploy、不碰 ~/.trellis/data.db（只允许 sqlite3 .backup 出副本）。完成后 git commit（只 add 自己改的路径），用契约里的 fj mail send result 汇报，artifacts 列改动文件与新测试。需要起隔离实例验证时照 scripts/mobile-verify/mobile-read-later.sh 的配方（真库副本 + 独立 HOME + TRELLIS_LARK=off + 独立端口 + agent-browser），本地 curl 加 --noproxy "*"，用完把实例停掉。
- [ ] panel-menu: 结构面板 / 地图 / 大纲的节点右键菜单（用 components/ui/ContextMenu.tsx 原语，动作全部复用现有 handler） | seat: gemini | keep-seat
  cid: fj-panel-menu-ecba
  verify: bunx tsc --noEmit
  verify: bun test
  main 上已有右键菜单原语 components/ui/ContextMenu.tsx（useContextMenu + <ContextMenu items>，portal 定位、键盘导航、视口翻转，文件头有用法），直接用，不要再造一个。
  范围（右侧那几块「树状预览」）：components/TreePanel.tsx（结构面板：列表视图的树行 / 节点行，graph 视图的节点）、components/CanvasMap.tsx（地图覆盖层的节点）、components/Outline.tsx（画布里的思维树行）。侧栏 SessionSidebar.tsx 不归你（另一单在改）。
  第一步先盘点：把这三个组件里每种行 / 节点现在能做的动作列成表（跳转 / 设为当前 / 追问·分支 / 重跑 / 收藏·稍后再读 / 折叠·展开子树 / 只看未读 / 删除节点含子树 / 复制内容或链接 / 新树 …），每个动作对应的现有 handler 或 store 动作（stores/sessionStore.ts）在哪，写进 out/actions.md。菜单项只从这张表来——右键菜单是「把已有动作放到指针下」，不新增行为；确有明显缺口只在 out/actions.md 记，不做。
  交付物：三个组件的对应元素挂 onContextMenu，菜单项按「导航 / 编辑 / 危险」分组用 separator 隔开，危险动作 danger 样式且沿用现有确认逻辑（DeleteCardButton 那套）；手机壳（useIsMobile）上长按 500ms 触发同一菜单（用 menu.openAt），不影响滚动与点击；桌面零回归。验收脚本 scripts/mobile-verify/desktop-context-menu.sh（照 mobile-read-later.sh 的配方，桌面视口）：右键结构面板一个节点 → 出现 data-testid=context-menu 且含「删除」项；Esc 关闭；点「跳转」类项后当前节点变化。脚本要能反复跑、自带起停实例，交付前实跑一次并把截图放 out/。
  【通用约束】worktree 基线 = main HEAD；开工前确认 node_modules 已装（setup_cmd 已跑 bun install，没装就自己跑）。验收：bunx tsc --noEmit 0 错、bun test 全绿（基线 317 pass）、bun --bun run build 通过。注释与界面文案用中文，风格跟随所在文件。不动 .fenjue/**、不 push、不 make deploy、不碰 ~/.trellis/data.db（只允许 sqlite3 .backup 出副本）。完成后 git commit（只 add 自己改的路径），用契约里的 fj mail send result 汇报，artifacts 列改动文件与新测试。需要起隔离实例验证时照 scripts/mobile-verify/mobile-read-later.sh 的配方（真库副本 + 独立 HOME + TRELLIS_LARK=off + 独立端口 + agent-browser），本地 curl 加 --noproxy "*"，用完把实例停掉。
- [ ] sidebar-nest: 侧栏会话行下嵌套「树 → 链」两层（可折叠、默认展开到树、单树会话不重复画树）+ 侧栏各行右键菜单 | seat: gemini | keep-seat
  cid: fj-sidebar-nest-7683
  verify: bunx tsc --noEmit
  verify: bun test
  背景：侧栏 v2（方案 A，progress/sidebar-tree-ia.md，09-09 上线）现在是 项目 → 工作区 → 会话 三层；用户要求会话（森林）之下再嵌套展示 树 → 链，可折叠，默认展开到树这一层。链 = 根→叶子 lineage，由链尾 tipId 唯一标识（S133 的定义，见 lib/recent.ts 与 lib/server/repo.ts 第 2461 行 listRecentChains 的递归 CTE；组件层 SessionSidebar.tsx 第 1530 行 ChainRow 与 stores/sessionStore.ts 第 1936 行 openNodeInSession 都还在，能复用就复用）。
  交付物：
  1. 数据：GET /api/sessions/[id]/structure —— 返回该会话的树列表（每棵：rootId、标题 treeLabel、节点数、最近活动时间、状态 等输入/生成中/出错/未读）与每棵树下的链列表（tipId、链尾标签、活动时间、状态），树与链都按最近活动降序。服务端把 listRecentChains 的 CTE 抽成按 session 取的函数（不要再写一份 CTE），归组逻辑放纯函数并配单测。不要并进 /api/sessions 那条热路径。
  2. 侧栏：会话行加折叠三角；展开时列出树行（缩进一级，复用 IndentGuide），树行可折叠、展开时列出链行（缩进两级，复用 ChainRow 的外观：↳ 链尾标签 · 相对时间 · 状态点）；点链行 → openNodeInSession(sessionId, tipId)；点树行 → 打开该树最近的链尾。默认：会话展开、树折叠（= 默认展开到树这一层）；只有一棵树的会话不画树行，展开会话直接看到它的链（避免 49/51 单树会话每行都重复一遍标题）。折叠状态进现有的 localStorage 折叠记忆（trellis-sidebar-collapsed 那套，键区分 session / tree），刷新后保持。结构数据在会话行首次展开时懒加载并缓存；sessionsRevision 变化、运行集合变化、窗口聚焦时刷新已展开会话的结构（S133 的刷新触发同款）。「按项目」「按时间」两种排布都要有这层；手机抽屉同样。
  3. 右键菜单：main 上已有 components/ui/ContextMenu.tsx（useContextMenu + <ContextMenu items>，文件头有用法），给侧栏项目行 / 工作区行 / 会话行 / 树行 / 链行各挂一个，菜单项只放该行现在已经有的动作（hover 图标、＋、overflow 里的那些：在此开会话、新建 worktree、固定、重命名、归档、删除、清理已合并 …），先在 out/actions.md 列表再实现，不新增行为；危险项 danger 样式并沿用现有确认。
  4. 测试：结构归组纯函数单测；验收脚本 scripts/mobile-verify/desktop-sidebar-nest.sh（照 mobile-read-later.sh 配方，桌面视口）：多树会话默认可见树行、链行不可见；展开一棵树后链行出现，点链行后当前节点 = 该链尾；单树会话没有树行；刷新后折叠状态保持；右键会话行出现 data-testid=context-menu。现有 mobile-verify 脚本零回归（至少实跑 mobile-slim-shell.sh 与 mobile-read-later.sh）。交付前把脚本实跑一次并把截图放 out/。
  约束：不要把退役的「🕘 最近」顶层组复活，链只出现在会话之下；不改 TreePanel / CanvasMap / Outline（另一单在改）；侧栏总行数在默认状态下只比现在多出「多树会话的树行」，不许默认把链全部摊开。
  【通用约束】worktree 基线 = main HEAD；开工前确认 node_modules 已装（setup_cmd 已跑 bun install，没装就自己跑）。验收：bunx tsc --noEmit 0 错、bun test 全绿（基线 317 pass）、bun --bun run build 通过。注释与界面文案用中文，风格跟随所在文件。不动 .fenjue/**、不 push、不 make deploy、不碰 ~/.trellis/data.db（只允许 sqlite3 .backup 出副本）。完成后 git commit（只 add 自己改的路径），用契约里的 fj mail send result 汇报，artifacts 列改动文件与新测试。需要起隔离实例验证时照 scripts/mobile-verify/mobile-read-later.sh 的配方（真库副本 + 独立 HOME + TRELLIS_LARK=off + 独立端口 + agent-browser），本地 curl 加 --noproxy "*"，用完把实例停掉。
- [ ] review-lark: 异源 review lark-card：卡片 schema 2.0 合规、四处调用点全切、降级路径可达、图片失败不阻塞、截断不切坏围栏 | after: lark-card | mode: readonly | seat: reviewer | keep-seat
  cid: fj-review-lark-27a0
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-lark-*/out/review.md 2>/dev/null | head -1); test -n "$f" && test -s "$f" && head -1 "$f" | grep -q "^verdict: "'
  审 lark-card 分支（workdir 即其 worktree，分支 audit/lark-card）。只读：不改被审代码；报告写到本单 out/review.md，首行必须是 verdict: pass 或 verdict: fail，fail 只认四种：结论 / 行为错、伪造或不可复现到影响结论、凭证泄露、破坏现有测试；其余写成建议并分 major / minor。
  判据：
  ① 卡片 JSON 符合飞书 schema 2.0（schema / config / body.elements，markdown 元素 tag 与转义），用单测里的 fixture 自己跑一遍并核对；
  ② 四处发送调用点（handler.ts 原 379 / 390 / 420 / 479 行处）与 push.ts 的定时任务推送全部切到卡片，且降级路径可达——构造飞书返回 code≠0 的桩证明纯文本兜底真的发出去；
  ③ 图片上传失败不阻塞正文；
  ④ 超长截断不切坏代码块围栏、尾部链接在；
  ⑤ bunx tsc --noEmit、bun test、bun --bun run build 在该 worktree 实跑；
  ⑥ 对照 /Users/smokingmouse/python/ai/happyclaw/src/feishu.ts、feishu-cards/builder.ts、feishu-markdown-style.ts 指出漏搬的关键处理（例如 markdown 方言转义、长度策略）。
- [ ] review-ttyd: 异源 review ttyd-linux：sha/版本钉死、失败不留半截文件、代理与原子写、候选优先级、mac 零变化、安装接口鉴权与并发闸 | after: ttyd-linux | mode: readonly | seat: reviewer | keep-seat
  cid: fj-review-ttyd-f904
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-ttyd-*/out/review.md 2>/dev/null | head -1); test -n "$f" && test -s "$f" && head -1 "$f" | grep -q "^verdict: "'
  审 ttyd-linux 分支（workdir 即其 worktree，分支 audit/ttyd-linux）。只读：不改被审代码；报告写到本单 out/review.md，首行必须是 verdict: pass 或 verdict: fail，fail 只认四种：结论 / 行为错、伪造或不可复现到影响结论、凭证泄露、破坏现有测试；其余写成建议并分 major / minor。
  判据：
  ① sha256 与版本钉死且来源可查（自己核一次 GitHub release 1.7.7 的资产哈希），校验失败不留文件（用桩 fetch 实跑单测并读代码路径）；
  ② 下载只走 https、遵守 https_proxy / HTTPS_PROXY、临时文件 + 原子 rename；
  ③ 候选顺序与 TRELLIS_TTYD_BIN 优先级正确；mac 上行为零变化（本机实跑探测结果与 main 对比）；
  ④ POST /api/terminals/install 有并发闸、鉴权与现有 terminals 路由同口径、不可被未登录调用；
  ⑤ TerminalPanel 错误态在 linux / mac 两种服务端报告下的渲染（renderToStaticMarkup 或截图）；
  ⑥ bunx tsc --noEmit、bun test、bun --bun run build 在该 worktree 实跑。
- [ ] review-ui: 异源 review 三条 UI 分支（sidebar-nest / panel-menu / card-image）：验收脚本实跑、桌面零回归、默认行数口径、菜单动作零新增、两两合并冲突、卡片图根因证据 | after: sidebar-nest,panel-menu,card-image | mode: readonly | seat: reviewer | keep-seat
  cid: fj-review-ui-0559
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-ui-*/out/review.md 2>/dev/null | head -1); test -n "$f" && test -s "$f" && head -1 "$f" | grep -q "^verdict: "'
  审三条 UI 分支：sidebar-nest（workdir，~/.herdr/worktrees/trellis/sidebar-nest）、panel-menu（~/.herdr/worktrees/trellis/panel-menu）、card-image（~/.herdr/worktrees/trellis/card-image）。只读：不改被审代码；报告写到本单 out/review.md，首行必须是 verdict: pass 或 verdict: fail，然后按分支分节各给一个小 verdict；fail 只认四种：结论 / 行为错、伪造或不可复现到影响结论、凭证泄露、破坏现有测试；其余写成建议并分 major / minor。
  判据：
  ① 三条分支各自的验收脚本实跑：scripts/mobile-verify/desktop-sidebar-nest.sh、scripts/mobile-verify/desktop-context-menu.sh、card-image 单 out/repro.md 里的复现步骤（截图对照）；
  ② 桌面零回归：mobile-slim-shell.sh、mobile-read-later.sh、mobile-branch-chain.sh 在 sidebar-nest 与 panel-menu 两个 worktree 各实跑一遍；
  ③ 侧栏默认状态行数只多出多树会话的树行（真库副本上数一遍，给数字）；单树会话不画树行；折叠状态刷新后保持；
  ④ 右键菜单动作都能对应到现有 store 动作 / handler（对照各单 out/actions.md；调用既有 store 动作、复制到剪贴板算复用，凭空新增业务逻辑才算新增）、危险动作有确认、手机长按不干扰滚动；
  ⑤ 三条分支两两合并是否冲突（在临时目录试 merge，报告冲突文件与建议合并顺序）；
  ⑥ card-image 根因证据是否成立（console 原文 vs 修法是否对症；修后四类回答都出图）；
  ⑦ 各 worktree 里 bunx tsc --noEmit、bun test、bun --bun run build 实跑。
  waiver: {"at":"2026-09-16T11:19:53.578Z","reason":"三条 fail（SN-1/PM-1/CI-1）已由 review-ui2（fj-review-ui2-26c7）独立复审确认真修，verdict pass","cid":"fj-review-ui-0559","settlement":"[\"420bd38ab36828ee3fd24c7503cae4fb97c699a2c74ae32c972f6becbcb5f269\",0,[\"2026-09-16T10:02:16.823Z\",\"420bd38ab36828ee3fd24c7503cae4fb97c699a2c74ae32c972f6becbcb5f269\",\"ad76a1fe0be6ca0f99931cb82fbb01bc6df919c5ded9d1a7091dac557f292943\",5,0,\"fail\",\"befc144d3c5240b91f95f6f0aebf8c9843401dae3ad6b4cbdece6e0aca97b39a\"]]"}
- [ ] ship: 起位前问用户：五条已验收分支合入 main、全套脚本实跑、make deploy 上线并验活，失败即回退 | after: review-lark,review-ttyd,review-ui,review-lark2,review-ttyd2,review-ui2,ui-polish | gate: review-lark,review-ttyd,review-ui,review-lark2,review-ttyd2,review-ui2 | seat: reviewer
  cid: fj-ship-3f07
  起位前问用户（授权卡：动生产环境必须问）。把五条已验收分支合入 main：建议顺序 ttyd-linux → lark-card → card-image → panel-menu → sidebar-nest（按 review-ui 报告的冲突建议调整），逐条 PR 合并或一条集成 PR；每次合并后在主仓 bunx tsc --noEmit、bun test、bun --bun run build 与全部 scripts/mobile-verify/*.sh 实跑；然后 make deploy 上线（scripts/deploy.ts 自带 smoke 与备份），验活失败立即回退上一版；上线后 prod 冒烟各截一张：侧栏嵌套树 / 右键菜单 / 卡片图导出 / 终端面板。把 release 号、合并 commit、冒烟截图写进 out/ship.md。
- [ ] lark-fix: 返工 lark-card：按异源 review 修 M1 字节预算 / M2 stripInvalidImageKeys / M3 图片来源白名单+超时 / M4 状态透传 / M5 push 双截断 / M6 占位符 nonce + 十条 minor | after: lark-card | seat: gemini | keep-seat
  cid: fj-lark-fix-6c8f
  verify: bunx tsc --noEmit
  verify: bun test
  返工 lark-card（分支 audit/lark-card，就在你现在这个 worktree 上继续，不要新开分支、不要改写已有 commit）。异源 review 报告在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-lark-27a0/out/review.md（含可复跑的 probe.ts / probe2.ts 与原始输出），先通读，再按下面清单逐条修，每条都要有单测锁住：
  M1 长度预算改按 UTF-8 字节：整卡 JSON（Buffer.byteLength(JSON.stringify(card))）≤ 24KB（飞书 30KB 硬限留余量）；分段与截断都按字节算；buildLarkCard 末尾做一次整卡字节兜底裁剪（裁剪不能切坏围栏、尾部保留「详情见 Trellis 会话」链接）；单段超限不再主动丢内容（m5：与 happyclaw 一致，只在整卡超预算时才截）。单测：15886 个中文字符输入 → 卡片字节 ≤ 24KB 且尾链在。
  M2 补回 happyclaw 的 stripInvalidImageKeys：优化尾部把所有非 img_ 前缀的 ![..](..) 引用去掉（代码块占位符保护下），带 title / 含空格 URL 的图片语法不得残留进 markdown 元素。
  M3 图片来源收紧：只接受 https:// URL；fetch 加 AbortSignal.timeout(5000)、响应 content-type 必须 image/ 前缀、≤10MB；解析后拒绝私网 / 环回 / link-local 地址（169.254.x、10.x、172.16-31.x、192.168.x、127.x、localhost）；本机路径只接受位于 ~/.trellis/ 之下或该会话工作区目录之下的文件（工作区路径从现有调用上下文拿，拿不到就不接受本机路径）——其余一律降级成「[图片] alt」文本，不读盘不下载。多图用 Promise.allSettled 并发（m7）。单测：/tmp 文件、http:// 明文、169.254 地址、超时桩 四种都不会被上传且正文照发。
  M4 状态透传：sendLarkText 增加 status / title 参数；handler 的失败分支（「Agent 执行失败」两处）传 { title: "执行失败", status: "error" } 让 header 变红；config.summary 给默认值（正文前 60 字）。
  M5 push.ts：卡片路径传原文，由分段统一管长度；taskLarkMarkdown 的 4000 字截断只用于降级纯文本；不再出现两套截断文案。
  M6 占位符加一次性随机 nonce（___TRELLIS_CB_<nonce>_<i>___），正文本来就含旧格式占位符时不再错位（review P8 用例进单测）。
  Minor 顺手修：m1（truncateMarkdown 不超 maxLen）、m2（降级日志只打 code / msg / label，异常只打 message）、m3（删无人用的 sendLarkCard 别名）、m4（删掉无消费方的 expanded 或补 collapsible_panel，二选一并说明理由）、m6（uploadLarkImage 收敛成单一对象签名）、m8（单行 ``` inline ``` 不当开围栏）、m9（hasH1toH3 在占位符化后的文本上判定）、m10（无 sessionUrl 时不渲染链接）。
  完成后 git commit（可以多个 commit），验收：bunx tsc --noEmit 0 错、bun test 全绿、bun --bun run build 通过；再把 review 的 probe.ts / probe2.ts 复跑一遍，在 result 的 proof 里附上 Q1（卡片字节数）与 P3 / P8 / Q3 的新输出。不动 .fenjue/**、不 push。用契约里的 fj mail send 汇报。
- [ ] review-lark2: 复审 lark-card 返工：用上一轮 probe 原样重打 M1–M6 / m1–m10，字节预算兜底不切坏围栏，M3 白名单与超时用桩证明 | after: lark-fix | mode: readonly | seat: reviewer | keep-seat
  cid: fj-review-lark2-b413
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-lark2-*/out/review.md 2>/dev/null | head -1); test -n "$f" && test -s "$f" && head -1 "$f" | grep -q "^verdict: "'
  复审 lark-card 返工（分支 audit/lark-card，workdir 即其 worktree）。只读。用你上一轮的 probe.ts / probe2.ts 原样重打 M1–M6 与 m1–m10（原报告与探针在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-lark-27a0/out/），逐条给「真修 / 未修 / 部分修」；额外核：整卡字节预算的兜底裁剪不切坏围栏且尾链在；M3 的 https-only / 私网拒绝 / 超时 / 大小 / 本机路径白名单用桩逐项证明；bunx tsc --noEmit、bun test、bun --bun run build 实跑。报告写 out/review.md，首行 verdict: pass|fail（fail 只认结论 / 行为错、不可复现、凭证泄露、破坏现有测试）。
- [ ] ttyd-fix: 返工 ttyd-linux：按异源 review 修 M1 下载超时+大小上限 / M2 临时文件泄漏 / M3 复探只认刚下载的二进制 / M4 安装成功与错误态文案打架 + 八条 minor | after: ttyd-linux | seat: gemini | keep-seat
  cid: fj-ttyd-fix-c821
  verify: bunx tsc --noEmit
  verify: bun test
  返工 ttyd-linux（分支 audit/ttyd-linux，就在你现在这个 worktree 上继续，不要新开分支、不要改写已有 commit）。异源 review 报告在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-ttyd-f904/out/review.md（附四张 UI 截图与复跑命令），先通读，再按清单逐条修，每条有单测锁住：
  M1 下载加 signal: AbortSignal.timeout(60_000)，并对 content-length 与实际读入字节设上限（ttyd 静态二进制约 1.4MB，上限 20MB），超时 / 超限都走失败路径并释放 installing 闸（闸用 try/finally 保证任何 settle 都释放）。单测：挂起的 fetch 桩 → 在超时后返回 ok:false 且再次调用不再 409。
  M2 临时文件：写盘前就登记 tempPath，清理放 finally（存在即 unlink）；单测：writeFileSync 抛 ENOSPC 后目录里没有 .ttyd.tmp.* 残留。
  M3 安装后的复探先单独探 targetPath（只用它自己跑 --version）：跑不起来就返回 ok:false、error「已下载到 <path> 但无法执行：<原因>」，不再把别的候选混进来冒充成功；跑得起来再走全表探测决定终端可用。单测：targetPath 探测失败 + 系统另有可用 ttyd → ok:false。
  M4 TerminalPanel：installMessage 按 retry 的结果改写——复探成功就清掉错误态，复探失败就把「安装成功，正在启动终端…」改成「已安装但终端仍不可用：<errorDetail>」，两句话不得同屏并存。
  Minor：m1 文案去掉双重括号，界面提示与日志 / 手动命令分开（日志里给 curl 命令，不给「点击下方」）；m2 probeSummary 恢复「探过 N 个路径，都不存在」的折叠（全都不存在时不刷整段 PATH）；m3 去掉 createCandidatesProxy，直接导出函数 ttydCandidates() / tmuxCandidates() 给消费点用；m4 删掉无人用的 TTYD_MISSING_MESSAGE / ttydInstallCommand，TTYD_HOST_DEPENDENCY_NOTE 与 ttydHostDependencyNote 合成一个真源；m5 删掉必然失败的 undici 兜底并改注释（代理只靠 Bun 原生 proxy 选项）；m6 arch 映射补 arm（armv7l → ttyd.arm）与 ia32 → ttyd.i686 并从官方 SHA256SUMS 钉死对应 sha（自己核一次），其余 arch 仍明确报不支持；m7 安装失败返回 500（ok:false 形状不变），前端同时兼容；m8 在 lib/ttyd-dependency.ts 顶部注释写明 mac 上 ~/.trellis/bin 与 ~/.local/bin 现在会优先于 homebrew。
  完成后 git commit（可多个），验收：bunx tsc --noEmit 0 错、bun test 全绿、bun --bun run build 通过；把 review 的 /tmp/ttyd-e2e.ts 类真下载用例（真网络，下载到临时目录）跑一遍并在 result 的 proof 里附结果。不动 .fenjue/**、不 push。用契约里的 fj mail send 汇报。
- [ ] review-ttyd2: 复审 ttyd-linux 返工：原样重打 M1–M4 / m1–m8，真下载用例复跑，mac 零变化再比一次 | after: ttyd-fix | mode: readonly | seat: reviewer | keep-seat
  cid: fj-review-ttyd2-8291
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-ttyd2-*/out/review.md 2>/dev/null | head -1); test -n "$f" && test -s "$f" && head -1 "$f" | grep -q "^verdict: "'
  复审 ttyd-linux 返工（分支 audit/ttyd-linux，workdir 即其 worktree）。只读。用你上一轮的方法（原报告与命令在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-ttyd-f904/out/）原样重打 M1–M4 与 m1–m8，逐条给「真修 / 未修 / 部分修」；真下载 + 钉死校验 + 校验失败不留文件 + 超时闸释放 四个用例在临时目录实跑；mac 零变化再对比一次（含 probeSummary 折叠恢复）；bunx tsc --noEmit、bun test、bun --bun run build 实跑。报告写 out/review.md，首行 verdict: pass|fail（fail 只认结论 / 行为错、不可复现、凭证泄露、破坏现有测试）。
- [ ] pm-fix: 返工 panel-menu：PM-1 右键 hook 引用不稳导致地图无限渲染崩溃、PM-2 验收脚本补地图与大纲、PM-3 手机长按脚本覆盖、PM-4 去 any、脚本 OUT_DIR 不再指向 .fenjue | after: panel-menu | seat: gemini | keep-seat
  cid: fj-pm-fix-2a7b
  verify: bunx tsc --noEmit
  verify: bun test
  返工 panel-menu（分支 audit/panel-menu，就在你现在这个 worktree 上继续，不要新开分支、不要改写已有 commit）。异源 review 在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-ui-0559/out/review.md 的「二、panel-menu」一节，先通读，再逐条修：
  PM-1（必修，页面崩溃级）：components/ui/ContextMenu.tsx 的 useContextMenu() 每次渲染返回新对象，useContextMenuWithTarget 的 bindTrigger 依赖它于是每渲染都换引用；CanvasMap.tsx 把 bindTrigger 放进 derivedNodes 的 useMemo 依赖，后面 useEffect 再 setFlowNodes(derivedNodes) → 自激无限渲染，打开画布地图直接把渲染进程打死（scripts/mobile-verify/mobile-slim-shell.sh 的 M11 步骤两次隔离复跑都崩）。修法：useContextMenu() 的返回值用 useMemo 稳住（open / point / props 变化时才变）；bindTrigger 只依赖稳定的 openAt / setTarget；CanvasMap 的 derivedNodes 不再因菜单 hook 而重算。修完 mobile-slim-shell.sh 必须整段跑绿。
  PM-2：scripts/mobile-verify/desktop-context-menu.sh 补两段——打开地图后右键一个节点出现菜单并含「删除」项；打开大纲后右键一行出现菜单；三处都断言 Esc 能关。
  PM-3：脚本再加一段手机视口（390x844）长按 600ms 一个结构面板节点出现菜单，且长按前后页面可正常滚动（滚动位置有变化）。
  PM-4：bindTrigger 的 6 处 any 换成 HTMLElement 泛型。
  脚本产物路径：OUT_DIR 改成 ${FENJUE_TASK_OUT:-/tmp/trellis-verify/context-menu}，仓库脚本里不得再出现 .fenjue 路径。
  另外把 mobile-branch-chain.sh 在没有其它实例并发时单独跑一遍，结果（exit 码 + 尾部日志）写进 result 的 proof；review 说它在并发下超时过一次，要定性是脚本资源竞争还是你的改动。
  验收：bunx tsc --noEmit 0 错、bun test 全绿、bun --bun run build 通过、desktop-context-menu.sh 与 mobile-slim-shell.sh / mobile-read-later.sh / mobile-branch-chain.sh 全部 exit 0（proof 里逐条附）。产物只写本单 out/ 或 /tmp。不动 .fenjue/**、不 push。用契约里的 fj mail send 汇报。
- [ ] ci-fix: 返工 card-image：CI-1 复现证据造假——repro 脚本真跑手机视口并逐用例落 console，repro.md 只写有证据的结论；脚本 OUT_DIR 不再指向 .fenjue | after: card-image | seat: gemini | keep-seat
  cid: fj-ci-fix-b5a7
  verify: bunx tsc --noEmit
  verify: bun test
  返工 card-image（分支 audit/card-image，就在你现在这个 worktree 上继续，不要新开分支、不要改写已有 commit）。异源 review 在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-ui-0559/out/review.md 的「三、card-image」一节，结论：代码修复本身通过（reviewer 独立复跑桌面 + 手机 8 次全部出图），但 out/repro.md 声称的「iPhone 15 移动端视口复现并捕获 console」从未发生——scripts/repro-card-image.sh 全程只有 ab set viewport 1280 900，4 份 repro_*_console.txt 里 3 份 0 字节，「render produced no image」这串字符不存在于任何落盘证据；根因 2（手机端 transform 包含块）与根因 3（pixelRatio 超 canvas 上限）标了「证实」但无产物支撑。这是伪造证据，必须纠正：
  1. scripts/repro-card-image.sh 改成对每个用例分别在桌面（1280x900）与手机（390x844）视口跑，逐用例逐视口落 console / errors / 截图（文件名带 desktop_ / mobile_ 前缀），并支持通过环境变量 TRELLIS_REPRO_REF 指定要复现的代码基线：修复前的证据在 main（53f859f）的临时 clone 构建上跑，修复后的证据在本分支上跑，两套都要落盘。
  2. 重写 out/repro.md：每条根因只保留有落盘证据支撑的结论，附对应文件名与 console 原文；修复前手机端如果根本不失败，就删掉根因 2 / 3 的「证实」并如实写「未复现，属推测」；根因 1（cacheBust 破坏 blob: URL）保留其证据。
  3. scripts/repro-card-image.sh 与 scripts/verify-card-image.sh 的 OUT_DIR 改成 ${FENJUE_TASK_OUT:-/tmp/trellis-verify/card-image}，仓库脚本里不得再出现 .fenjue 路径。
  4. 代码不需要再改；若为了证据必须改脚本以外的文件，先发 blocker 说明。
  验收：bunx tsc --noEmit 0 错、bun test 全绿、bun --bun run build 通过；verify-card-image.sh 与 repro-card-image.sh（修复前 + 修复后两套）exit 0，proof 里附每个用例每个视口的 console 文件字节数与关键原文。产物只写本单 out/ 或 /tmp。不动 .fenjue/**、不 push。用契约里的 fj mail send 汇报。
- [ ] sn-fix: 返工 sidebar-nest：SN-1 默认态按树数决定折叠（多树展开到树、单树折叠）、SN-2 只拉展开会话且 CTE 加上限、SN-3 legacy 侧栏链行重复、SN-4 补固定会话并回填 actions.md、SN-5 合入 panel-menu 后接手机长按、SN-6 脚本 OUT_DIR | after: pm-fix | seat: gemini | keep-seat
  cid: fj-sn-fix-17b6
  verify: bunx tsc --noEmit
  verify: bun test
  返工 sidebar-nest（分支 audit/sidebar-nest，就在你现在这个 worktree 上继续，不要新开分支、不要改写已有 commit）。异源 review 在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-ui-0559/out/review.md 的「一、sidebar-nest」一节，先通读。第一步：git merge audit/panel-menu（该分支已含右键原语的修正与 useContextMenuWithTarget 长按 hook，文件零重叠、可直接合），然后逐条修：
  SN-1（必修，行为错）：默认态实测 392 行，判据只允许 222 行——单树会话默认把链全铺出来了。改成「默认折叠状态由树数决定」：多树会话默认展开到树行（树行自身折叠、链不可见）；单树会话默认折叠（会话行就是它唯一的树，点开才铺链）；用户手动展开 / 折叠都写进 localStorage 折叠记忆（要能同时表达「显式展开」与「显式折叠」，不能只存折叠集合），刷新后保持。单测覆盖默认判定；真库副本上默认首屏行数 = 会话行 + 多树会话的树行，链行 0，把数字写进 proof。
  SN-2：结构请求只对当前展开的会话发；listSessionChains 恢复上限（每会话链数 ≤ 200，树数不限）；首屏不得出现几十个并发 structure 请求（proof 里附首屏请求数）。
  SN-3：legacy 侧栏（NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off）的 renderRecentGroup 不再嵌套铺链，避免同一会话链行画两遍；用 off 模式实跑截图证明。
  SN-4：会话行菜单补「固定 / 取消固定」（既有 pinSession handler）；链行文案统一为「打开此链」；按实现回填 out/actions.md。
  SN-5：侧栏项目 / 工作区 / 会话 / 树 / 链五种行改用 useContextMenuWithTarget 的 bindTrigger（桌面右键 + 手机 500ms 长按），手机抽屉里长按可出菜单且不干扰滚动；desktop-sidebar-nest.sh 加一段手机视口长按断言。
  SN-6：desktop-sidebar-nest.sh 的 OUT_DIR 改成 ${FENJUE_TASK_OUT:-/tmp/trellis-verify/sidebar-nest}，仓库脚本里不得再出现 .fenjue 路径。
  验收：bunx tsc --noEmit 0 错、bun test 全绿、bun --bun run build 通过；desktop-sidebar-nest.sh、desktop-context-menu.sh（合入后一并跑）、mobile-slim-shell.sh、mobile-read-later.sh、mobile-branch-chain.sh 全部 exit 0，proof 逐条附。产物只写本单 out/ 或 /tmp。不动 .fenjue/**、不 push。用契约里的 fj mail send 汇报。
- [ ] review-ui2: 复审三条 UI 返工：SN-1 默认行数 222、PM-1 地图不崩、mobile-branch-chain 隔离复跑、card-image 证据真实、三分支合并顺序与语义冲突 | after: pm-fix,sn-fix,ci-fix | mode: readonly | seat: reviewer | keep-seat
  cid: fj-review-ui2-26c7
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-ui2-*/out/review.md 2>/dev/null | head -1); test -n "$f" && test -s "$f" && head -1 "$f" | grep -q "^verdict: "'
  复审三条 UI 分支返工（workdir 是 sidebar-nest 的 worktree，其余两条在 ~/.herdr/worktrees/trellis/panel-menu 与 ~/.herdr/worktrees/trellis/card-image）。只读。原报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-ui-0559/out/review.md，用同一套方法原样重打 SN-1～SN-6、PM-1～PM-4、CI-1 及其余项，逐条给「真修 / 未修 / 部分修」；重点：① 真库副本默认首屏行数 = 会话行 + 多树树行、链行 0，且首屏 structure 请求只对展开会话发；② panel-menu 与 sidebar-nest（已合入 panel-menu）两个 worktree 各自把 mobile-slim-shell.sh / mobile-read-later.sh / mobile-branch-chain.sh 在无并发下逐个跑；③ card-image 的修复前 / 修复后两套证据文件真实存在且 repro.md 每条结论有对应文件；④ 三条分支合并顺序（panel-menu → sidebar-nest → card-image）在临时 clone 真合并并跑 desktop-sidebar-nest.sh 与 desktop-context-menu.sh 验语义冲突；⑤ 仓库脚本里不再有 .fenjue 路径（grep）。脚本产物一律写 /tmp，不写任何 .fenjue/tasks 目录。报告 out/review.md 首行 verdict: pass|fail，按分支分节。
- [ ] ui-polish: 合入前收尾（sidebar-nest 分支，含 panel-menu）：X-1 store 调试钩子只在验证构建暴露、X-2 恢复 page.tsx 的 CANVAS_MAP 渲染闸并让 Outline 测试不再依赖拆闸、X-3 长按滚动断言改成真断言、X-4 注释去字面量 | after: review-ui2 | seat: gemini | keep-seat
  cid: fj-ui-polish-3b86
  verify: bunx tsc --noEmit
  verify: bun test
  在 audit/sidebar-nest 分支（你现在的 worktree，它已包含 audit/panel-menu）上继续，不要新开分支、不要改写已有 commit。复审报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-ui2-26c7/out/review.md 的「六、本轮新发现」X-1～X-4 与 PM-2 / PM-3 一节，逐条修：
  X-1（必修）：stores/sessionStore.ts 末尾把 useSessionStore 挂到 window.__sessionStore 的调试钩子进了生产包（任何能在页面执行 JS 的东西都能绕过确认弹窗直接改 store）。改成只在验证构建暴露：沿用仓库已有的 NEXT_PUBLIC_TRELLIS_VERIFY 构建期闸（rg 一下它现在怎么用、mobile-verify 脚本怎么在 build 时传），普通 bun --bun run build 的 .next/static/chunks 里 grep 不到 __sessionStore；两条 desktop 脚本构建时带上该闸。
  X-2（必修）：app/page.tsx 第 175 行附近被拆掉的 {session && !CANVAS_MAP && viewMode === "canvas" && …} 闸恢复原样（不改产品去迁就测试）。desktop-context-menu.sh 里 Outline 那段：Outline 在 CANVAS_MAP 开启的生产形态下不可达，把这段改成只在 NEXT_PUBLIC_TRELLIS_CANVAS_MAP 关闭的实例上跑（脚本内起第二个实例或用环境变量分支），或者删掉这段并在脚本注释里写明原因；TreePanel + CanvasMap + 手机长按三段保持。
  X-3：PM-3 的「长按不干扰滚动」断言恒真。改成真断言：派发 touchstart → 位移 >10px 的 touchmove → 断言菜单没有弹出（定时器被取消）；再来一次不动的 500ms 长按 → 断言菜单弹出。
  X-4：desktop-sidebar-nest.sh 第 18 行注释不要含 .fenjue 字面量，改成「产物路径不得写死治理目录，走 FENJUE_TASK_OUT」。
  验收：bunx tsc --noEmit 0 错、bun test 全绿、bun --bun run build 通过且 grep -r __sessionStore .next/static/chunks 为空（proof 里附命令与输出）；desktop-context-menu.sh、desktop-sidebar-nest.sh、mobile-slim-shell.sh、mobile-read-later.sh、mobile-branch-chain.sh 全部 exit 0（无并发、逐个跑，proof 逐条附）。产物只写 /tmp 或本单 out/。不动 .fenjue/**、不 push。用契约里的 fj mail send 汇报。
