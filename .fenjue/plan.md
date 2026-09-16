# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | kind: codex | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。


目标：体验优化五件：飞书机器人富文本卡片、Linux 终端 ttyd 自愈、卡片图导出修复、侧栏与结构面板右键菜单、侧栏嵌套树+链（实现全走 gemini 3.8，review 异源 codex）
- [ ] lark-card: 飞书机器人回复改为 Schema 2.0 互动卡片（markdown 富文本 + 图片 image_key），抄 happyclaw 的卡片构建器 | seat: gemini | keep-seat
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
  verify: bunx tsc --noEmit
  verify: bun test
  现象：用户点回答卡片上的「卡片图」按钮（components/CardImageButton.tsx：html-to-image 把这轮问答渲染成 PNG 后弹预览让用户复制 / 下载）会失败（进入 error 态或图空白）。
  第一步先复现，不要凭猜修：起隔离实例（真库副本）用 agent-browser 打开一个有真实回答的会话点「卡片图」，把浏览器 console 报错与结果截图存到 out/；分别试含代码块 / 含图片 / 含 KaTeX 公式 / 含 mermaid 的回答各一例，记录哪些失败、报什么。常见根因候选（逐个证实或排除）：跨域样式表让 html-to-image 读 cssRules 抛错、字体内联失败、跨域图片污染 canvas、foreignObject 在 WebKit 上的限制、卡片尺寸超 canvas 上限、CSP 拦 data: / blob:。
  参考实现：/Users/smokingmouse/python/ai/happyclaw/web/src/components/chat/ShareImageDialog.tsx（同样用 html-to-image 的 toCanvas，注意它对字体、图片、iOS、重试与 dataURL 下载的处理）与 web/src/utils/download.ts。把它证明有效的做法搬过来（例如 toCanvas 参数、skipFonts / fontEmbedCSS、图片跨域处理、pixelRatio、iOS 分支），不要整体替换成别的库。
  交付物：CardImageButton.tsx 修复；out/repro.md 写清复现步骤、根因证据（console 原文）、修法；修后同一批用例全部出图并把成功截图放 out/；若有纯函数逻辑（如样式过滤、尺寸计算）抽到 lib/ 并配 bun 单测。桌面与手机壳都要验证（手机侧若有入口一并验）。
  【通用约束】worktree 基线 = main HEAD；开工前确认 node_modules 已装（setup_cmd 已跑 bun install，没装就自己跑）。验收：bunx tsc --noEmit 0 错、bun test 全绿（基线 317 pass）、bun --bun run build 通过。注释与界面文案用中文，风格跟随所在文件。不动 .fenjue/**、不 push、不 make deploy、不碰 ~/.trellis/data.db（只允许 sqlite3 .backup 出副本）。完成后 git commit（只 add 自己改的路径），用契约里的 fj mail send result 汇报，artifacts 列改动文件与新测试。需要起隔离实例验证时照 scripts/mobile-verify/mobile-read-later.sh 的配方（真库副本 + 独立 HOME + TRELLIS_LARK=off + 独立端口 + agent-browser），本地 curl 加 --noproxy "*"，用完把实例停掉。
- [ ] panel-menu: 结构面板 / 地图 / 大纲的节点右键菜单（用 components/ui/ContextMenu.tsx 原语，动作全部复用现有 handler） | seat: gemini | keep-seat
  verify: bunx tsc --noEmit
  verify: bun test
  main 上已有右键菜单原语 components/ui/ContextMenu.tsx（useContextMenu + <ContextMenu items>，portal 定位、键盘导航、视口翻转，文件头有用法），直接用，不要再造一个。
  范围（右侧那几块「树状预览」）：components/TreePanel.tsx（结构面板：列表视图的树行 / 节点行，graph 视图的节点）、components/CanvasMap.tsx（地图覆盖层的节点）、components/Outline.tsx（画布里的思维树行）。侧栏 SessionSidebar.tsx 不归你（另一单在改）。
  第一步先盘点：把这三个组件里每种行 / 节点现在能做的动作列成表（跳转 / 设为当前 / 追问·分支 / 重跑 / 收藏·稍后再读 / 折叠·展开子树 / 只看未读 / 删除节点含子树 / 复制内容或链接 / 新树 …），每个动作对应的现有 handler 或 store 动作（stores/sessionStore.ts）在哪，写进 out/actions.md。菜单项只从这张表来——右键菜单是「把已有动作放到指针下」，不新增行为；确有明显缺口只在 out/actions.md 记，不做。
  交付物：三个组件的对应元素挂 onContextMenu，菜单项按「导航 / 编辑 / 危险」分组用 separator 隔开，危险动作 danger 样式且沿用现有确认逻辑（DeleteCardButton 那套）；手机壳（useIsMobile）上长按 500ms 触发同一菜单（用 menu.openAt），不影响滚动与点击；桌面零回归。验收脚本 scripts/mobile-verify/desktop-context-menu.sh（照 mobile-read-later.sh 的配方，桌面视口）：右键结构面板一个节点 → 出现 data-testid=context-menu 且含「删除」项；Esc 关闭；点「跳转」类项后当前节点变化。脚本要能反复跑、自带起停实例，交付前实跑一次并把截图放 out/。
  【通用约束】worktree 基线 = main HEAD；开工前确认 node_modules 已装（setup_cmd 已跑 bun install，没装就自己跑）。验收：bunx tsc --noEmit 0 错、bun test 全绿（基线 317 pass）、bun --bun run build 通过。注释与界面文案用中文，风格跟随所在文件。不动 .fenjue/**、不 push、不 make deploy、不碰 ~/.trellis/data.db（只允许 sqlite3 .backup 出副本）。完成后 git commit（只 add 自己改的路径），用契约里的 fj mail send result 汇报，artifacts 列改动文件与新测试。需要起隔离实例验证时照 scripts/mobile-verify/mobile-read-later.sh 的配方（真库副本 + 独立 HOME + TRELLIS_LARK=off + 独立端口 + agent-browser），本地 curl 加 --noproxy "*"，用完把实例停掉。
- [ ] sidebar-nest: 侧栏会话行下嵌套「树 → 链」两层（可折叠、默认展开到树、单树会话不重复画树）+ 侧栏各行右键菜单 | seat: gemini | keep-seat
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
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-ui-*/out/review.md 2>/dev/null | head -1); test -n "$f" && test -s "$f" && head -1 "$f" | grep -q "^verdict: "'
  审三条 UI 分支：sidebar-nest（workdir，~/.herdr/worktrees/trellis/sidebar-nest）、panel-menu（~/.herdr/worktrees/trellis/panel-menu）、card-image（~/.herdr/worktrees/trellis/card-image）。只读：不改被审代码；报告写到本单 out/review.md，首行必须是 verdict: pass 或 verdict: fail，然后按分支分节各给一个小 verdict；fail 只认四种：结论 / 行为错、伪造或不可复现到影响结论、凭证泄露、破坏现有测试；其余写成建议并分 major / minor。
  判据：
  ① 三条分支各自的验收脚本实跑：scripts/mobile-verify/desktop-sidebar-nest.sh、scripts/mobile-verify/desktop-context-menu.sh、card-image 单 out/repro.md 里的复现步骤（截图对照）；
  ② 桌面零回归：mobile-slim-shell.sh、mobile-read-later.sh、mobile-branch-chain.sh 在 sidebar-nest 与 panel-menu 两个 worktree 各实跑一遍；
  ③ 侧栏默认状态行数只多出多树会话的树行（真库副本上数一遍，给数字）；单树会话不画树行；折叠状态刷新后保持；
  ④ 右键菜单动作与既有 handler 一一对应（对照各单 out/actions.md）、没有新增行为、危险动作有确认、手机长按不干扰滚动；
  ⑤ 三条分支两两合并是否冲突（在临时目录试 merge，报告冲突文件与建议合并顺序）；
  ⑥ card-image 根因证据是否成立（console 原文 vs 修法是否对症；修后四类回答都出图）；
  ⑦ 各 worktree 里 bunx tsc --noEmit、bun test、bun --bun run build 实跑。
- [ ] ship: 起位前问用户：五条已验收分支合入 main、全套脚本实跑、make deploy 上线并验活，失败即回退 | after: review-lark,review-ttyd,review-ui | gate: review-lark,review-ttyd,review-ui | seat: reviewer
  起位前问用户（授权卡：动生产环境必须问）。把五条已验收分支合入 main：建议顺序 ttyd-linux → lark-card → card-image → panel-menu → sidebar-nest（按 review-ui 报告的冲突建议调整），逐条 PR 合并或一条集成 PR；每次合并后在主仓 bunx tsc --noEmit、bun test、bun --bun run build 与全部 scripts/mobile-verify/*.sh 实跑；然后 make deploy 上线（scripts/deploy.ts 自带 smoke 与备份），验活失败立即回退上一版；上线后 prod 冒烟各截一张：侧栏嵌套树 / 右键菜单 / 卡片图导出 / 终端面板。把 release 号、合并 commit、冒烟截图写进 out/ship.md。
