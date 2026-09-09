# plan（leader 拆解的计划；fj next 按依赖推「可起」，fj status 顶部画目标图）

写法：`- [ ] id: 一句话 | after: a,b | mode: readonly | kind: codex | keep-seat`，缩进两格的续行写多行目标或 `verify: <命令>`。
id 只用 [a-z0-9-]；after 写依赖项的 id（都验收通过才可起）；keep-seat = 验收后坐席留着给下一单复用（review 循环用）。
状态不用手改：绑了 cid 的项从任务推导；没绑的 [ ] 待做、[x] 已做、[-] 放弃。

目标：Trellis 会话驱动层切到 agent-server：先论证（原生功能对齐清单 + fj 坐席 dogfood 方案），再按退出标准切流

- [ ] audit: 手机视口走查 Trellis 全部关键动线，产出带截图证据、按 P0-P2 分级的缺陷清单与 3-6 项可独立验收的拆解建议 | mode: readonly | kind: codex
  cid: fj-audit-f928
  verify: sh -c 'f=$(ls .fenjue/tasks/fj-audit-*/out/audit.md 2>/dev/null | head -1); test -n "$f" && test -s "$f"'
  verify: sh -c 'test "$(ls .fenjue/tasks/fj-audit-*/out/screenshots/*.png 2>/dev/null | wc -l)" -ge 8'
  verify: sh -c 'f=$(ls .fenjue/tasks/fj-audit-*/out/audit.md 2>/dev/null | head -1); grep -q "P0" "$f" && grep -q -E "^\| *M[0-9]+" "$f"'
  verify: sh -c '! lsof -nP -iTCP:3467 -sTCP:LISTEN >/dev/null 2>&1'
  交付物（全部落在本任务的 out/ 目录）：
  1. out/audit.md，五节：
  §1 现状盘点：仓库里已有的移动端适配（断点常量、useIsMobile / matchMedia、抽屉、触屏控件、safe-area、viewport meta、100vh/dvh 用法、PWA manifest 有无），给出文件:行。
  §2 动线走查：每条动线给「截图路径 + 观察 + 判定（可用 / 勉强 / 不可用）」。动线：a 登录页；b 侧栏——打开、浏览「最近」分组与会话列表、切会话、关闭；c 打开一棵有内容的树——画布视图与线性视图在手机上的可读性、触摸缩放/拖动、节点卡片宽度、代码块横向溢出；d 阅读一条长回答——滚动、折叠、代码块、图片、复制按钮可点性；e 输入动线——底部 Composer 在软键盘弹出时的表现（用 viewport 390x480 近似键盘占位）、附件/发送按钮、@agent 与模型选择器；f 追问与开分支——BranchPopover 等触屏可点性；g 审批卡 / 提问卡——库副本里有停在等待状态的节点就实走，没有就读代码按元素尺寸判定；h 新建会话 / 新建树 / 停止 run 的入口在手机上能否找到并点到；i 设置页、任务页、agent 管理页；j 深链——飞书推送点开的 /?session=…&node=… 一类链接在手机上落到哪（读代码确认路由参数）。
  §3 缺陷清单：表格，列 = 编号 M1… / 动线 / 症状 / 严重度 P0-P2（P0 手机上根本做不了这件事，P1 能做但很费劲，P2 观感）/ 频度 / 根因定位 file:line / 修法建议 / 规模 S-M-L。点击热区小于 44x44 CSS px 记为 P1 可点性问题，用 getBoundingClientRect 量。每条必须带截图或测量数据，不许凭代码猜。
  §4 拆解建议：把修法按「可独立验收的交付物」分成 3-6 项，每项一句话 + 涉及文件 + 用 agent-browser 在手机视口自动验收的方式 + 项间依赖；标出 P0 项。
  §5 可复用的 agent-browser 验收脚本骨架（设 iPhone 设备、登录、打开页面、量尺寸、截图），供后续实现单当 verify。
  2. out/screenshots/NN-<动线>-<说明>.png，至少 8 张。
  3. out/README.md：一段交付说明，指向 audit.md，写明 P0/P1/P2 各几条。
  隔离实例起法（已实测，照做）：
  H=/tmp/trellis-mobile-audit-home; mkdir -p $H/.trellis
  sqlite3 ~/.trellis/data.db ".backup $H/.trellis/data.db"
  sqlite3 $H/.trellis/data.db "UPDATE tasks SET enabled=0; UPDATE lark_bots SET app_secret='invalid', enabled=0;"   （若有 task_triggers 表也 enabled=0）
  bun install --frozen-lockfile（node_modules 缺时）; bun --bun run build
  HOME=$H TRELLIS_DB_PATH=$H/.trellis/data.db TRELLIS_LARK=off bun --bun run start -- -p 3467   （后台跑；prod 就是这个 start = bun server.ts；要登录闸就加 TRELLIS_AUTH_PASS=audit）
  验活：curl --noproxy '*' http://127.0.0.1:3467/
  浏览器用 agent-browser（agent-browser --help；device "iPhone 15" 或 viewport 390 844，命名 session，结束 close）。
  硬约束：只读——不改任何 git 跟踪文件；绝不碰 ~/.trellis/data.db 本体、~/.trellis/current、launchd、make deploy、3088/3200 端口；不发起真实模型 run（花额度，且隔离 HOME 下无凭证），输入动线走到点发送前为止；不用 next dev（HOME 覆盖下 Turbopack 报 Invalid distDirRoot）；本机 curl 走代理，打本地端口必须 --noproxy '*'。结束前关掉 3467 上的实例进程和 agent-browser session。每完成两条动线发一封 progress。
- [-] design: 手机模式方案：手机壳的判定、信息架构、四条核心动线交互稿、PWA 就绪项、技术路线取舍与可并行的实现拆解，写成 progress 风格 spec 供用户拍板 | after: audit | mode: readonly | kind: claude
  verify: sh -c 'f=$(ls .fenjue/tasks/fj-design-*/out/mobile-mode.md 2>/dev/null | head -1); test -n "$f" && test "$(grep -c "^## " "$f")" -ge 8'
  verify: sh -c '! lsof -nP -iTCP:3467 -sTCP:LISTEN >/dev/null 2>&1'
  输入：审计单 fj-audit-f928 的 out/audit.md 与 out/screenshots/（在 .fenjue/archive/ 或 .fenjue/tasks/ 下找）；用户原话：「我一般用 Safari 加到主屏。手机上常用的就是看回答、追问、打审批卡、开新会话。最难受的点本质是我在手机上的使用场景比较有限，但网页上存在很多复杂的功能配置都覆盖在主页上，在手机上这些复杂功能就会影响我的核心体验。」
  交付物 out/mobile-mode.md（给用户读 §1-§4 拍方向，给实现坐席读 §5-§7），八节：
  §1 目标与非目标：手机只做四件事；桌面功能不删只藏；桌面端零回归；不做原生 App、不做离线。
  §2 手机模式的判定与出口：视口断点 / UA / display-mode: standalone 三者如何组合；用户从手机切回完整桌面版的出口；桌面缩窄窗口是否也进手机模式（给推荐）。
  §3 手机壳的信息架构：首屏落在哪（最近会话链尾的线性视图？）、顶栏与底栏各放什么（会话切换、新建会话、待审批入口）、主页现有控件逐个判「留 / 藏进 overflow / 手机不提供」并列成表（以审计 §4 的清单为底）。
  §4 四条核心动线的手机交互稿：读回答（线性视图、折叠、代码块横滑、图片）、追问（Composer 常驻底部、键盘弹出时的布局、发送与停止）、答审批卡 / 提问卡（在流里置顶还是独立待办页、一键批准/拒绝、误触防护）、开新会话（一步到位、默认 agent 与模型怎么定）。文字为主，必要处 ASCII 线框。
  §5 PWA standalone 就绪：需要补的 meta / manifest / 图标、viewport-fit=cover 与 safe-area-inset、100dvh、防双击缩放、状态栏样式、重连提示；逐项给文件位置。
  §6 技术方案：独立路由（如 /m）换壳 vs 同组件响应式切壳 vs 布局层分叉，三者取舍与推荐；store / 数据获取如何共享；涉及的文件清单；如何保证桌面端零回归（哪些测试、哪些 agent-browser 桌面视口对照截图）。
  §7 拆解：3-6 个可独立验收的实现项，每项一句话 + 涉及文件 + 验收命令（agent-browser iPhone 视口脚本或单测）+ 依赖 + 规模 S/M/L；标出第一批必做项。各项之间尽量无依赖以便并行开 worktree。
  §8 需要用户拍板的选项 ≤3 个，每个给推荐与理由；以及风险。
  约束：只读，不改任何 git 跟踪文件；以审计的截图与测量为事实依据，代码读到什么就写什么，不写「实测」字样除非你真跑过；可按审计 §5 的脚本在隔离实例上核对个别疑点，结束关掉实例；全文控制在 600 行内；给用户读的部分用日常语言。
- [ ] mobile-safe-area: standalone 安全区与视口基线：viewport-fit、safe-area 变量、theme-color、dvh 清残留（M3/M12） | kind: codex
  cid: fj-mobile-safe-area-c317
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh -c '! lsof -nP -iTCP:3471 -sTCP:LISTEN >/dev/null 2>&1'
  交付物：Safari 主屏 standalone 下的安全区与视口基线（审计 M3、M12 的 standalone 部分）。
  1. app/layout.tsx viewport 加 viewportFit:"cover"；运行时输出 <meta name="theme-color">（Next viewport.themeColor，颜色与 public/manifest.json 的 theme_color 一致，有明暗两套就按 media 分别给）。
  2. app/globals.css 定义一次 --safe-top/--safe-bottom/--safe-left/--safe-right = env(safe-area-inset-*)，env() 只写在这里，其它地方只消费变量；Header（components/Header.tsx 固定 top-0）、LinearThreadView 底部 Composer 区（components/LinearThreadView.tsx:424-437）、components/ui/Drawer.tsx 的 bottom sheet、modal 壳分别消费，避免重复 padding。
  3. 把残留 h-screen / min-h-screen / 100vh 换成 dvh：components/Canvas.tsx:390、components/QuestionInput.tsx:250、app/login/page.tsx:41、app/page.tsx:94、components/Outline.tsx:193（calc(100vh…)）。
  4. 不加 service worker；不改 user-scalable。
  验收脚本 scripts/mobile-verify/mobile-safe-area.sh 断言：viewport meta 含 viewport-fit=cover；存在 theme-color meta；:root 可读到 --safe-bottom；Header 与 Composer 容器的样式消费了该变量（读 stylesheet 文本或 computed 自定义属性）；静态 grep 全仓无 100vh/h-screen/min-h-screen 残留；390×844 与 390×480 截图无顶部/底部裁切；1280×800 下 --safe-* 求值为 0px 且 Header 高度、Composer 位置与改前实测一致。端口 3471。
  【通用约束】
  - 在你的 worktree 干活，先 bun install --frozen-lockfile（无 node_modules 时 tsc 会报几百个假错）。
  - 规格来源 = 主仓审计报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-audit-f928/out/audit.md（若不在 archive 就在 .fenjue/tasks/ 同名目录）及其 screenshots/：§1 现状、§3 缺陷 M1–M12（含 file:line）、§4 首屏裁决表、§5 agent-browser 脚本骨架。
  - 手机改动只在手机断点下生效：复用 hooks/useIsMobile.ts（max-width 767px）或 Tailwind max-md:/md: 同一条线，不新造断点。桌面零回归：1280×800 下结构、可见控件、尺寸与改前一致，验收脚本必须含桌面对照断言（先在改前实测记录数值/清单，写进脚本断言）。
  - 交付自包含验收脚本 scripts/mobile-verify/<slug>.sh，从 worktree 根执行、失败非零退出：① 需要时 bun --bun run build；② 用真库在线备份起隔离实例：H=/tmp/trellis-mv-<slug>; mkdir -p $H/.trellis; sqlite3 ~/.trellis/data.db ".backup $H/.trellis/data.db"; sqlite3 $H/.trellis/data.db "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid'"; HOME=$H TRELLIS_DB_PATH=$H/.trellis/data.db TRELLIS_LARK=off bun --bun run start -- -p <port> 后台跑（不用 next dev；本机 curl 打本地必须 --noproxy '*'）；③ agent-browser 用独立 session 名 mv-<slug>，device "iPhone 15"（390×844）、键盘态 viewport 390 480、桌面对照 viewport 1280 800；④ 结束无论成败都杀掉 <port> 上的进程并 agent-browser close。
  - 不发起真实模型 run（花额度且隔离 HOME 无凭证），输入动线走到发送前为止；不碰 ~/.trellis/data.db 本体、prod 3088/3200、launchd。
  - 可用纯函数/组件测试覆盖的逻辑补 bun test；不改无关代码、不整文件格式化、不重排无关代码（并行单会碰同一文件，如 LinearThreadView.tsx / Composer.tsx，改动保持局部以减少合并冲突）。
  - 完成后 git commit（可多次）不 push；commit message 中文，说明手机端改动与桌面零回归的验证方式。
- [ ] mobile-touch-targets: 手机核心热区 44px 基线：Button/IconButton 手机最小尺寸 + 审批卡/会话行/复制/分支/新树控件逐点覆盖 + 等待态 fixture（M4/M6/M7/M9） | kind: codex
  cid: fj-mobile-touch-targets-6ea6
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh -c '! lsof -nP -iTCP:3472 -sTCP:LISTEN >/dev/null 2>&1'
  交付物：手机核心热区 44×44 基线（审计 M4、M6、M7、M9 的尺寸部分与 M5 的按钮尺寸部分）。
  1. components/ui/Button.tsx 与 components/ui/IconButton.tsx 增加仅手机断点生效的最小尺寸（如 max-md:min-h-11 max-md:min-w-11 或等价 CSS），桌面尺寸不变；可给极少数高密度场景加显式 opt-out prop，但核心动线控件不得 opt-out。
  2. 逐点覆盖并测量：审批卡 允许/总是允许/拒绝 与 Ask 选项/提交（components/InteractionForm.tsx:196-242,312-327,392-478）；会话 drawer 的 新会话/关闭/会话行 min-height 44（components/SessionSidebar.tsx:839-870,1047-1054,1307-1310）；代码块复制按钮（app/globals.css:735-746、components/CodeBlock.tsx:151-167）；回答动作区 标为已读/分支 等（components/LinearThreadView.tsx:551-624、components/TurnCard.tsx:444-465）；BranchPopover 两键与底栏按钮尺寸（components/BranchPopover.tsx:122-142,196-245；越界 clamp 不在本单）；新树 modal 关闭/取消/开始（components/NewQuestionPicker.tsx:55-74,112-123）。
  3. 等待态 fixture：在库副本里造一个等待审批的节点和一个 Ask 提问节点（读 InteractionForm 与节点写入代码确定字段，用 SQL 或调用 server 函数），让脚本能打开真实渲染的审批卡与提问卡测量；造法写进脚本供后续单复用。
  验收脚本 scripts/mobile-verify/mobile-touch-targets.sh：iPhone 15 下对上述每个控件 getBoundingClientRect 断言 width>=44 && height>=44（列出选择器与实测值）；1280×800 下同一批控件尺寸与改前实测一致。端口 3472。
  【通用约束】
  - 在你的 worktree 干活，先 bun install --frozen-lockfile（无 node_modules 时 tsc 会报几百个假错）。
  - 规格来源 = 主仓审计报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-audit-f928/out/audit.md（若不在 archive 就在 .fenjue/tasks/ 同名目录）及其 screenshots/：§1 现状、§3 缺陷 M1–M12（含 file:line）、§4 首屏裁决表、§5 agent-browser 脚本骨架。
  - 手机改动只在手机断点下生效：复用 hooks/useIsMobile.ts（max-width 767px）或 Tailwind max-md:/md: 同一条线，不新造断点。桌面零回归：1280×800 下结构、可见控件、尺寸与改前一致，验收脚本必须含桌面对照断言（先在改前实测记录数值/清单，写进脚本断言）。
  - 交付自包含验收脚本 scripts/mobile-verify/<slug>.sh，从 worktree 根执行、失败非零退出：① 需要时 bun --bun run build；② 用真库在线备份起隔离实例：H=/tmp/trellis-mv-<slug>; mkdir -p $H/.trellis; sqlite3 ~/.trellis/data.db ".backup $H/.trellis/data.db"; sqlite3 $H/.trellis/data.db "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid'"; HOME=$H TRELLIS_DB_PATH=$H/.trellis/data.db TRELLIS_LARK=off bun --bun run start -- -p <port> 后台跑（不用 next dev；本机 curl 打本地必须 --noproxy '*'）；③ agent-browser 用独立 session 名 mv-<slug>，device "iPhone 15"（390×844）、键盘态 viewport 390 480、桌面对照 viewport 1280 800；④ 结束无论成败都杀掉 <port> 上的进程并 agent-browser close。
  - 不发起真实模型 run（花额度且隔离 HOME 无凭证），输入动线走到发送前为止；不碰 ~/.trellis/data.db 本体、prod 3088/3200、launchd。
  - 可用纯函数/组件测试覆盖的逻辑补 bun test；不改无关代码、不整文件格式化、不重排无关代码（并行单会碰同一文件，如 LinearThreadView.tsx / Composer.tsx，改动保持局部以减少合并冲突）。
  - 完成后 git commit（可多次）不 push；commit message 中文，说明手机端改动与桌面零回归的验证方式。
- [ ] mobile-slim-shell: 手机精简壳：slim header + overflow 收纳桌面能力 + TreePanel 手机不悬浮 + 转桌面版开关 + spec progress/mobile-shell.md（M1/M2/M11） | kind: codex
  cid: fj-mobile-slim-shell-5418
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh -c '! lsof -nP -iTCP:3473 -sTCP:LISTEN >/dev/null 2>&1'
  交付物：手机精简壳（审计 M1、M2、M11 入口 + §4「手机首屏信息裁决」表），并把裁决写成 progress/mobile-shell.md（spec：留/藏清单、overflow 结构、转桌面版机制、验收方式）在你分支上提交。
  1. components/Header.tsx：手机断点下渲染 slim header = 会话 drawer 入口 + 当前会话短标题 + 一个 overflow「…」；其余桌面能力（搜索、思维树/画布、工作区文件、笔记、导出、mode badge、模型、主题、任务、设置、管理后台）进 overflow（新建 components/MobileOverflowMenu.tsx，用现有 Drawer bottom sheet 形态，每项 min-height 44）。桌面 header 完全不变。
  2. components/TreePanel.tsx（:80,884-1002）：手机默认不展开/不挂载悬浮面板；入口在 overflow「思维树」，打开后是全屏 sheet，不悬浮压正文与 Composer；关闭回到线性视图。
  3. 「转桌面版」：overflow 一项，写 localStorage 标记后刷新，useIsMobile 读到标记返回 false（改 hooks/useIsMobile.ts，保持其它调用方语义）；桌面 header 在窄视口且标记存在时提供「回手机版」入口，清标记刷新。
  4. 画布入口进 overflow；进入手机画布后延迟一次 fitView（components/Canvas.tsx:387-430）。
  验收脚本 scripts/mobile-verify/mobile-slim-shell.sh：iPhone 15 打开有内容会话，断言 header scrollWidth===clientWidth、可见 header 按钮只有 drawer 入口与 overflow；点开 overflow 断言含 搜索/思维树/设置/模型/转桌面版 等项且每项高>=44；390×480 下 TreePanel 不与正文或 Composer 矩形相交（或不存在）；设置标记后刷新断言桌面 header 出现；1280×800 桌面 header 可见按钮集合与改前一致（aria-label/文本清单写进脚本）。端口 3473。
  【通用约束】
  - 在你的 worktree 干活，先 bun install --frozen-lockfile（无 node_modules 时 tsc 会报几百个假错）。
  - 规格来源 = 主仓审计报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-audit-f928/out/audit.md（若不在 archive 就在 .fenjue/tasks/ 同名目录）及其 screenshots/：§1 现状、§3 缺陷 M1–M12（含 file:line）、§4 首屏裁决表、§5 agent-browser 脚本骨架。
  - 手机改动只在手机断点下生效：复用 hooks/useIsMobile.ts（max-width 767px）或 Tailwind max-md:/md: 同一条线，不新造断点。桌面零回归：1280×800 下结构、可见控件、尺寸与改前一致，验收脚本必须含桌面对照断言（先在改前实测记录数值/清单，写进脚本断言）。
  - 交付自包含验收脚本 scripts/mobile-verify/<slug>.sh，从 worktree 根执行、失败非零退出：① 需要时 bun --bun run build；② 用真库在线备份起隔离实例：H=/tmp/trellis-mv-<slug>; mkdir -p $H/.trellis; sqlite3 ~/.trellis/data.db ".backup $H/.trellis/data.db"; sqlite3 $H/.trellis/data.db "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid'"; HOME=$H TRELLIS_DB_PATH=$H/.trellis/data.db TRELLIS_LARK=off bun --bun run start -- -p <port> 后台跑（不用 next dev；本机 curl 打本地必须 --noproxy '*'）；③ agent-browser 用独立 session 名 mv-<slug>，device "iPhone 15"（390×844）、键盘态 viewport 390 480、桌面对照 viewport 1280 800；④ 结束无论成败都杀掉 <port> 上的进程并 agent-browser close。
  - 不发起真实模型 run（花额度且隔离 HOME 无凭证），输入动线走到发送前为止；不碰 ~/.trellis/data.db 本体、prod 3088/3200、launchd。
  - 可用纯函数/组件测试覆盖的逻辑补 bun test；不改无关代码、不整文件格式化、不重排无关代码（并行单会碰同一文件，如 LinearThreadView.tsx / Composer.tsx，改动保持局部以减少合并冲突）。
  - 完成后 git commit（可多次）不 push；commit message 中文，说明手机端改动与桌面零回归的验证方式。
- [ ] review-a: 异源 review 前三条分支：桌面零回归、门控统一、冲突与合并顺序、验收脚本是否空转 | after: mobile-safe-area,mobile-touch-targets,mobile-slim-shell | mode: readonly | kind: claude | keep-seat
  cid: fj-review-a-1296
  verify: sh -c 'f=$(ls .fenjue/tasks/fj-review-a-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  审三条分支 feat/mobile-safe-area、feat/mobile-touch-targets、feat/mobile-slim-shell 相对 main 的 diff（worktree 在 ~/.herdr/worktrees/trellis/feat-mobile-*；git diff main...<branch>）。重点：① 桌面零回归——任何非手机断点下的可见/尺寸/行为变化都是 major；② 手机门控是否统一走 useIsMobile / max-md 同一条线；③ 三条分支互相冲突点（同文件同区域）与合并顺序建议；④ safe-area 变量是否只定义一次、有无重复 padding；⑤ 44px 改动有没有把桌面 Button 撑大；⑥ 每条分支的验收脚本是否真能证明它声称的事（读脚本，指出断言空转处）。结论写 out/review.md：首行 verdict: pass|fail（任一分支有 major 即 fail），按分支列可操作问题（file:line + 修法），最后给合并顺序。可在各 worktree 跑 bun test / tsc / 验收脚本复现，但不改任何文件。
- [-] ship-a: 合并一波集成分支 feat/mobile-wave1 并上线（PR → merge → make deploy → 验活）；起位前问用户 | after: review-a4 | mode: readonly | kind: codex
  cid: fj-ship-a-8419
  verify: sh -c 'test "$(readlink ~/.trellis/current | xargs basename | cut -d- -f2)" = "$(git rev-parse --short=9 HEAD)"'
  verify: sh -c 'curl -s --noproxy "*" -m 5 http://127.0.0.1:3088/__gate/health | grep -q "\"gate\":\"up\",\"next\":\"ready\""'
  【起位前必须由用户点头：发布 + 动 prod】把集成分支 feat/mobile-wave1（已包含 feat/mobile-safe-area、feat/mobile-touch-targets、feat/mobile-slim-shell 与 review 修复）推到 origin、开一个 PR、merge 进 main（--merge，不删分支），主仓 git pull --ff-only（不碰主控未提交的 progress 文件），make deploy HEAD（自带 smoke 与自动回滚），验活：~/.trellis/current 指向新 release、/__gate/health gate up/next ready/auth on、lark_bots.last_error 空且 10 分钟内重连、agent-browser 以 iPhone 视口打 prod 一次做 slim header 断言（只读，不发消息不起 run）。唯一允许的副作用就是这些命令，其余禁止。
- [ ] mobile-followup-approval: 追问与审批手机闭环 + Composer 手机收纳：阅读时输入区自动收成一行并可随下滑隐藏、BranchPopover 不越界/bottom sheet、审批卡手机布局防误触、等待项横幅、键盘态发送可见（M5/M6 + 用户实测反馈） | after: review-a4 | kind: codex
  cid: fj-mobile-followup-approval-d408
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-followup-approval.sh
  verify: sh -c '! lsof -nP -iTCP:3474 -sTCP:LISTEN >/dev/null 2>&1'
  交付物：追问与审批的手机闭环（审计 M5 越界/形态、M6 布局、Composer 键盘态；基于已合并进 main 的 slim shell 与 44px 基线，worktree 从最新 main 建）。
  1. components/BranchPopover.tsx：手机下改 bottom sheet 或做左右边界 clamp，rect.left>=0 && rect.right<=innerWidth；一级只留「追问」，「摘到笔记」等进次级。
  2. components/InteractionForm.tsx：手机下审批/Ask 专用布局，危险动作（拒绝/总是允许）留足间距防误触；提交按钮在键盘态可见。
  3. components/LinearThreadView.tsx + Composer.tsx：当前会话存在等待审批/提问的节点时，手机顶部出现可点的「有 N 项等你处理」横幅，点击滚到该卡片；键盘态（390×480）下发送/停止按钮始终可见。
  4. 复用 mobile-touch-targets 单留下的等待态 fixture 造法。
  验收脚本 scripts/mobile-verify/mobile-followup-approval.sh：选中回答文字→追问 popover 展开→断言矩形在视口内→填文案不发送；fixture 会话打开断言横幅存在、点击后审批卡进入视口、按钮>=44；390×480 断言发送按钮 rect.bottom<=innerHeight；1280×800 断言 BranchPopover 与 InteractionForm 桌面形态与改前一致。端口 3474。
  【通用约束】
  - 在你的 worktree 干活，先 bun install --frozen-lockfile（无 node_modules 时 tsc 会报几百个假错）。
  - 规格来源 = 主仓审计报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-audit-f928/out/audit.md（若不在 archive 就在 .fenjue/tasks/ 同名目录）及其 screenshots/：§1 现状、§3 缺陷 M1–M12（含 file:line）、§4 首屏裁决表、§5 agent-browser 脚本骨架。
  - 手机改动只在手机断点下生效：复用 hooks/useIsMobile.ts（max-width 767px）或 Tailwind max-md:/md: 同一条线，不新造断点。桌面零回归：1280×800 下结构、可见控件、尺寸与改前一致，验收脚本必须含桌面对照断言（先在改前实测记录数值/清单，写进脚本断言）。
  - 交付自包含验收脚本 scripts/mobile-verify/<slug>.sh，从 worktree 根执行、失败非零退出：① 需要时 bun --bun run build；② 用真库在线备份起隔离实例：H=/tmp/trellis-mv-<slug>; mkdir -p $H/.trellis; sqlite3 ~/.trellis/data.db ".backup $H/.trellis/data.db"; sqlite3 $H/.trellis/data.db "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid'"; HOME=$H TRELLIS_DB_PATH=$H/.trellis/data.db TRELLIS_LARK=off bun --bun run start -- -p <port> 后台跑（不用 next dev；本机 curl 打本地必须 --noproxy '*'）；③ agent-browser 用独立 session 名 mv-<slug>，device "iPhone 15"（390×844）、键盘态 viewport 390 480、桌面对照 viewport 1280 800；④ 结束无论成败都杀掉 <port> 上的进程并 agent-browser close。
  - 不发起真实模型 run（花额度且隔离 HOME 无凭证），输入动线走到发送前为止；不碰 ~/.trellis/data.db 本体、prod 3088/3200、launchd。
  - 可用纯函数/组件测试覆盖的逻辑补 bun test；不改无关代码、不整文件格式化、不重排无关代码（并行单会碰同一文件，如 LinearThreadView.tsx / Composer.tsx，改动保持局部以减少合并冲突）。
  - 完成后 git commit（可多次）不 push；commit message 中文，说明手机端改动与桌面零回归的验证方式。
  5.【用户 09-05 真机反馈，本单必做】手机阅读时底部 Composer 常驻一整块（textarea 44px + 三个 44px 按钮 + py-3）太占屏。目标：默认「紧凑态」——单行 48px 左右（占位「追问…」+ 发送/停止），点击或聚焦展开为完整态（附件/草图按钮与多行 textarea），失焦且为空时回到紧凑态；向下滑动阅读时紧凑条整体隐藏（translateY 出屏），向上滑或滑到底部时再出现，运行中始终至少露出停止按钮；等待审批/提问时不隐藏。桌面不变。验收：390×844 断言紧凑态 Composer 容器高度 ≤ 56px、滚动 300px 后容器 rect.top ≥ innerHeight（已隐藏）、回滚后重新可见、点击后 textarea 可聚焦且展开高度 ≥ 88px；键盘态 390×480 展开后发送按钮 rect.bottom ≤ innerHeight。
  6.【用户 09-05 真机反馈】顶栏右侧被截断（含「项目选择」区域）即审计 M1，一波 slim header 已处理；本单起单前主控核实项目/工作区选择控件在手机 slim header 或 overflow/抽屉里有可达入口，若无则先补。
  7.【基线】worktree 基于 feat/mobile-wave1（3a9db8d，已过四轮 review，即将合入 main），不要基于 main；不要碰三条源分支与 wave1 分支本身。顺带做一波遗留 T-2：手机卡片上的 CLI resume / 重生成 / 分享卡等非核心动作收进卡片「…」，一级只留复制与追问/分支；以及 N-1：删掉 8 处已被 globals.css 全局兜底覆盖的 max-md:text-[16px] 类名（Composer/BranchPopover/NewQuestionPicker/SearchModal/InteractionForm×3/login），并在 globals.css 那条规则旁注明「组件侧无需再加类」。
- [ ] mobile-new-session: 新会话精简首屏：只留输入/附件/开始，模式模型一行摘要，其余折进更多设置；新树 modal 键盘态与文案（M8/M9） | after: review-a4 | kind: codex
  cid: fj-mobile-new-session-101a
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-new-session.sh
  verify: sh -c '! lsof -nP -iTCP:3475 -sTCP:LISTEN >/dev/null 2>&1'
  交付物：新会话精简首屏（审计 M8、M9 文案/布局部分；worktree 从最新 main 建）。
  1. components/QuestionInput.tsx(:248-290,318-420)：手机首屏只留问题输入、附件、开始；当前默认模式/模型显示成一行可点摘要；Agent、增强模式、快捷键、历史深度、专注写作、草图、starter 模板全部折进「更多设置」bottom sheet，展开后仍可配置；起步提示不被高级配置挤走；提供「转桌面版」链接（复用 slim shell 机制）。
  2. components/SessionSidebar.tsx：drawer 里「新会话」为主动作；Attach CLI 等收入高级区。
  3. components/NewQuestionPicker.tsx：新树 modal 键盘态布局不裁切，文案明确「新树」与「新会话」的区别。
  验收脚本 scripts/mobile-verify/mobile-new-session.sh：drawer 点新会话；390×480 断言 输入/附件/开始 均在首屏且>=44；首屏文本不含「增强模式」「历史深度」「专注写作」；点「更多设置」后这些项出现；1280×800 桌面新会话页控件集合与改前一致。端口 3475。
  【通用约束】
  - 在你的 worktree 干活，先 bun install --frozen-lockfile（无 node_modules 时 tsc 会报几百个假错）。
  - 规格来源 = 主仓审计报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-audit-f928/out/audit.md（若不在 archive 就在 .fenjue/tasks/ 同名目录）及其 screenshots/：§1 现状、§3 缺陷 M1–M12（含 file:line）、§4 首屏裁决表、§5 agent-browser 脚本骨架。
  - 手机改动只在手机断点下生效：复用 hooks/useIsMobile.ts（max-width 767px）或 Tailwind max-md:/md: 同一条线，不新造断点。桌面零回归：1280×800 下结构、可见控件、尺寸与改前一致，验收脚本必须含桌面对照断言（先在改前实测记录数值/清单，写进脚本断言）。
  - 交付自包含验收脚本 scripts/mobile-verify/<slug>.sh，从 worktree 根执行、失败非零退出：① 需要时 bun --bun run build；② 用真库在线备份起隔离实例：H=/tmp/trellis-mv-<slug>; mkdir -p $H/.trellis; sqlite3 ~/.trellis/data.db ".backup $H/.trellis/data.db"; sqlite3 $H/.trellis/data.db "UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid'"; HOME=$H TRELLIS_DB_PATH=$H/.trellis/data.db TRELLIS_LARK=off bun --bun run start -- -p <port> 后台跑（不用 next dev；本机 curl 打本地必须 --noproxy '*'）；③ agent-browser 用独立 session 名 mv-<slug>，device "iPhone 15"（390×844）、键盘态 viewport 390 480、桌面对照 viewport 1280 800；④ 结束无论成败都杀掉 <port> 上的进程并 agent-browser close。
  - 不发起真实模型 run（花额度且隔离 HOME 无凭证），输入动线走到发送前为止；不碰 ~/.trellis/data.db 本体、prod 3088/3200、launchd。
  - 可用纯函数/组件测试覆盖的逻辑补 bun test；不改无关代码、不整文件格式化、不重排无关代码（并行单会碰同一文件，如 LinearThreadView.tsx / Composer.tsx，改动保持局部以减少合并冲突）。
  - 完成后 git commit（可多次）不 push；commit message 中文，说明手机端改动与桌面零回归的验证方式。
  4.【用户 09-05 真机反馈，本单必做】手机上新会话首屏顶部的模式 / 项目（工作区）选择那一行被右侧截断，右边控件看不到（对应 QuestionInput 顶部 ModePicker + WorkspaceField 区域）。要求：390×844 与 390×480 下该区域不横向溢出——ModePicker 与 WorkspaceField 换行或改成全宽两行；工作区路径中间省略、选择按钮 ≥44px 且完整可见；断言 document.documentElement.scrollWidth === innerWidth，且首屏每个可见控件 rect.right <= innerWidth、rect.left >= 0。
  5.【基线】worktree 基于 feat/mobile-wave1（3a9db8d），不要基于 main。顺带做一波遗留 N-3：手机 390×844 下 /settings/prefs 在 select 变 16px 后截图确认「上下文历史深度」等标签不再被挤成竖排，若挤则改上下堆叠。
- [ ] review-b: 异源 review 后两条分支，判据同 review-a | after: mobile-followup-approval,mobile-new-session | mode: readonly | kind: claude | keep-seat
  cid: fj-review-b-bcb6
  verify: sh -c 'f=$(ls .fenjue/tasks/fj-review-b-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  审 feat/mobile-followup-approval 与 feat/mobile-new-session 相对 main 的 diff，判据与 review-a 相同（桌面零回归为 major、门控统一、验收脚本是否空转、两分支冲突与合并顺序）。结论写 out/review.md，首行 verdict: pass|fail。
- [ ] ship-b: 合并二波集成分支 feat/mobile-wave2（含一波）并上线（PR → merge → make deploy → 验活）；起位前问用户 | after: review-b3 | mode: readonly | kind: codex
  cid: fj-ship-b-3a0a
  verify: sh -c 'curl -s --noproxy "*" -m 5 http://127.0.0.1:3088/__gate/health | grep -q "\"gate\":\"up\",\"next\":\"ready\""'
  【起位前必须由用户点头：发布 + 动 prod】同 ship-a 流程：推 feat/mobile-wave2（已含 feat/mobile-wave1 与二波两分支及全部 review 修复）、开一个 PR、merge 进 main、主仓 git pull --ff-only、make deploy HEAD、验活（current 指向新 release / gate / lark 重连 / iPhone 视口只读冒烟含紧凑 Composer 与新会话首屏截图）。若 ship-a 已先上线，本单只是把差量合入。
- [ ] fix-a: 一波集成：合并三分支到 feat/mobile-wave1，修 review-a 的 S-1 major、M-1/M-3 合并语义断点与全部 minor，补转桌面版回归断言 | after: review-a | kind: codex | keep-seat
  cid: fj-fix-a-15a5
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh -c 'git merge-base --is-ancestor feat/mobile-safe-area HEAD && git merge-base --is-ancestor feat/mobile-touch-targets HEAD && git merge-base --is-ancestor feat/mobile-slim-shell HEAD'
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh -c 'for p in 3471 3472 3473; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; exit 0'
  交付物：一波集成分支 feat/mobile-wave1（你的 worktree 已从 main 22f6044 建好，先 bun install --frozen-lockfile）。
  ① 按顺序 git merge --no-ff feat/mobile-safe-area → feat/mobile-touch-targets → feat/mobile-slim-shell。唯一文本冲突 components/Canvas.tsx 取并集：保留 h-dvh（safe-area 侧）与 data-canvas-surface（slim 侧）。
  ② 在集成结果上逐条修 review 报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-a-1296/out/review.md 指出的问题（先通读全文，编号以它为准）：
  必修 major：S-1 「转桌面版」在 390px 产出 210px 幽灵侧栏 + 180px 正文且 ☰ 消失——采用报告修法 1+2：SessionSidebar 的 --trellis-sb offset 判据改为真实视口 ≥768px（不再用 useIsMobile），narrowDesktopOverride 下保留 ☰ 以打开 md:hidden 的会话 drawer；M-1 slim 手机 header 补 data-safe-area="header" 与 height calc(3rem + var(--safe-top)) / paddingTop var(--safe-top)；M-3 mobile-touch-targets.sh 里 new-tree-open 断言改为先经 overflow→思维树 打开 sheet 再测（或把新树入口放进 overflow 并改测新入口，二选一并同步 spec）。
  应修 minor（都在本单做）：A-1 Canvas.tsx pt-12 与 app/page.tsx top-12 改读统一的 header 高度变量（如 --trellis-header-h）；A-2 themeColor 按 prefers-color-scheme 给明暗两值并与 public/manifest.json 一致，同步放松脚本里「两者相等」的断言；S-4 树 sheet 消费 --safe-top/--safe-bottom，打开时初始焦点到关闭按钮；S-7 overflow 补「上下文占用」入口打开同一弹窗；T-1 侧栏任务占位行/归档会话行/分组标题行同样 max-md:h-11，五处收敛为一个 rowHeightClass；S-3 Header 首帧空白——Home 已算出的 isMobile 以 prop 传给 Header 与 LinearThreadView（单一真相源），或 useIsMobile 改 useSyncExternalStore + useLayoutEffect 在 paint 前定值；T-3 useIsMobile 查询改 (max-width: 767.98px)；S-5 narrowDesktopOverride 进 state 并监听 matchMedia change；S-6 只读行去掉 hover 样式；A-3 mobile-safe-area.sh 补 Drawer/Modal 底部按钮 rect.bottom <= innerHeight - 模拟 safe-bottom 的几何断言；T-4 mobile-touch-targets.sh 固定 sleep 换成条件等待。
  产品取舍（照此执行，不再讨论）：A-4 放开系统缩放——viewport maximumScale 5、userScalable true，画布表面加 touch-action: none 让 React Flow 保住手势，脚本里 userScalable 守闸同步改；S-2 接受「JS 说桌面 / CSS 说手机」的混合态，在 progress/mobile-shell.md 写明；T-2（非核心卡片动作在手机收进卡片 …）不在本单做，写进 spec 的「二波 TODO」节。
  ③ 新增回归断言到 scripts/mobile-verify/mobile-slim-shell.sh：390×844 下写入 trellis-desktop-mode 标记并刷新后，断言线性阅读面 rect.left==0 且 width>=382、☰ 会话列表可见且尺寸>=44、点击后 drawer 出现；清标记刷新后恢复手机壳。
  ④ 三条脚本在集成分支上串行各跑一遍全绿（端口 3471/3472/3473，用 agent-browser close --all; env -i HOME=$HOME PATH=$PATH sh <script> </dev/null 的方式），再跑 bunx tsc --noEmit 与 bun test。按主题分组 commit，message 引用 review 编号（S-1/M-1…）。不 push。
- [ ] review-a2: 复审集成分支 feat/mobile-wave1：S-1/M-1/M-3 与各 minor 是否真修且无回归，合并结果与三条源分支一致，三条脚本实跑，桌面零回归再测 | after: fix-a | mode: readonly | kind: claude | keep-seat
  cid: fj-review-a2-4ecb
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-a2-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  复审 feat/mobile-wave1（worktree /Users/smokingmouse/.herdr/worktrees/trellis/feat-mobile-wave1）相对 main：逐条核对你上一份 review（.fenjue/archive/fj-review-a-1296/out/review.md）的 S-1、M-1、M-3 与全部 minor 是否真修（重跑 S-1 PoC）、有无新回归；git diff 确认三条源分支的改动都进了集成分支且没有被合并吞掉；三条脚本在集成 worktree 串行实跑；1280×800 桌面零回归再测一次。结论 out/review.md 首行 verdict: pass|fail，只列可操作问题。只 diagnose 不改文件。
- [ ] fix-a2: 修复审 W-1 iOS 聚焦自动放大（手机可聚焦输入 ≥16px + 脚本断言）与 W-2/W-3 两条 nit | after: review-a2 | kind: codex | keep-seat
  cid: fj-fix-a2-37b3
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh -c 'for p in 3471 3472 3473; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; exit 0'
  在 feat/mobile-wave1 上继续（你的 worktree）。复审报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-a2-4ecb/out/review.md 的三条：W-1（major）手机断点下所有可聚焦 input/textarea 的 computed font-size ≥16px，桌面不变——Composer textarea、BranchPopover 追问输入、新树 modal 输入、登录页 #pw、搜索框、InteractionForm 自定义答案输入，统一用 max-md:text-[16px] 或等价；并在 scripts/mobile-verify/mobile-safe-area.sh 的 390×844 段新增断言「所有可见 input,textarea 的 computed font-size >= 16px」（同时在打开追问 popover 与新树 modal 的状态下各测一次）。W-2 useViewportMedia 初值改惰性 () => typeof window !== 'undefined' && window.matchMedia(query).matches。W-3 Header.tsx 手机与桌面两处 header 高度改读 var(--trellis-header-h)。三条脚本串行重跑全绿（agent-browser close --all; env -i HOME=$HOME PATH=$PATH sh <script> </dev/null），commit message 引用 W-1/W-2/W-3，不 push。
- [ ] review-a3: 复核 W-1/W-2/W-3 修复与无回归，三条脚本实跑 | after: fix-a2 | mode: readonly | kind: claude | keep-seat
  cid: fj-review-a3-0fcd
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-a3-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  复核 feat/mobile-wave1 最新提交：你上一份复审（.fenjue/archive/fj-review-a2-4ecb/out/review.md）的 W-1/W-2/W-3 是否真修（390×844 实测所有可见 input/textarea computed font-size ≥16px，含追问 popover 与新树 modal 状态；桌面 1280×800 字号不变）；增量 diff 无其它改动、无回归；三条脚本串行实跑。结论 out/review.md 首行 verdict: pass|fail，只列可操作问题。只 diagnose 不改文件。
- [ ] fix-a3: 系统性修 V-1/V-2：全局 CSS 手机断点 input/textarea/select 16px + 遍历式守闸（静态黑名单扫描 + 三个新状态运行时断言） | after: review-a3 | kind: codex | keep-seat
  cid: fj-fix-a3-9c20
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh -c 'for p in 3471 3472 3473; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; exit 0'
  在 feat/mobile-wave1 上继续。复核报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-a3-0fcd/out/review.md 的 V-1、V-2，按其修法 3 + 1 + 2 叠加做：① app/globals.css 加一条 @media (max-width: 767.98px) { input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), textarea, select { font-size: 16px; } }（如项目用 Tailwind 层，放在合适的 layer 让组件类不会覆盖它；若某些组件用 text-xs 等类覆盖了它，确认这条规则优先级足够，必要时加 !important 并在 spec 写明理由），已加的 max-md:text-[16px] 可保留；② 把 scripts/mobile-verify/mobile-safe-area.sh 的白名单式静态闸换成黑名单扫描：断言 globals.css 含该规则，并扫 app components 下所有 <input / <textarea（排除 type=checkbox|radio|range|file|hidden）列出没有该规则兜底的显式小字号覆盖（如 text-xs !font-size 内联），有则 fail，需要豁免写显式 allowlist 并注明理由；③ 运行时断言补三个状态并复用现成 fieldSizes 块：☰→新会话首屏、…→思维树→过滤输入、线性卡片→编辑问题；并额外做一次「所有可见 input/textarea/select ≥16px」的通扫；④ 顺手扫 reviewer 列的其它可达表单（SessionSidebar 重命名/分支名、CliAttachPicker、settings 与各 Picker），CSS 规则应已覆盖，脚本里至少对 drawer 内 Attach CLI 输入实测一次。桌面 1280×800 字号保持不变并断言。三条脚本串行重跑全绿（agent-browser close --all; env -i HOME=$HOME PATH=$PATH sh <script> </dev/null），commit 引用 V-1/V-2，不 push。
- [ ] review-a4: 复核 V-1/V-2 系统性修复：三处输入实测 16px、通扫断言、桌面不变、脚本实跑 | after: fix-a3 | mode: readonly | kind: claude | keep-seat
  cid: fj-review-a4-a087
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-a4-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  复核 feat/mobile-wave1 最新提交（增量基准 e82c6c2）：你上一份复核（.fenjue/archive/fj-review-a3-0fcd/out/review.md）的 V-1 三处与 V-2 守闸是否按系统性修法真修——重跑 /tmp/poc-a3.sh 与 /tmp/poc-a3b.sh 同等路径实测 新会话首屏/树过滤/编辑提问 三处 ≥16px，再随机抽两处 overflow→设置可达的表单实测；静态闸是否真能在故意加一处 text-xs 输入时变红（可在临时目录复制脚本验证，不改仓库）；桌面 1280×800 字号不变；增量 diff 无其它改动；三条脚本串行实跑。结论 out/review.md 首行 verdict: pass|fail，只列可操作问题。只 diagnose 不改文件。
- [ ] fix-b: 二波集成：合并两分支到 feat/mobile-wave2、解 NewQuestionPicker 冲突，修 F-1 停止可达断言 / F-2 紧凑态保留附件 / F-4 横幅轮转 / N-1 首帧占位 / N-2 选择器收窄，五条脚本整套重跑 | after: review-b | kind: codex | keep-seat
  cid: fj-fix-b-9be8
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh -c 'git merge-base --is-ancestor feat/mobile-followup-approval HEAD && git merge-base --is-ancestor feat/mobile-new-session HEAD && git merge-base --is-ancestor feat/mobile-wave1 HEAD'
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh scripts/mobile-verify/mobile-followup-approval.sh
  verify: sh scripts/mobile-verify/mobile-new-session.sh
  verify: sh -c 'for p in 3471 3472 3473 3474 3475; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; ! test -d /tmp/trellis-mobile-verify.lock'
  交付物：二波集成分支 feat/mobile-wave2（你的新 worktree 已从 feat/mobile-wave1 3a9db8d 建好；注意先 cd 到该 worktree，不要在 wave1 worktree 里改）。
  ① 按顺序 git merge --no-ff feat/mobile-followup-approval → feat/mobile-new-session。唯一冲突 components/NewQuestionPicker.tsx 的 textarea className 取并集并丢掉死代码类名：className="w-full px-3 py-2 max-md:h-24 rounded-field border border-line-strong bg-surface text-ink text-sm outline-none focus:border-accent-line resize-none leading-relaxed placeholder:text-ink-faint"。
  ② 在集成结果上修 review 报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-b-bcb6/out/review.md 的问题：
  - F-1（必做，安全网）：给 scripts/mobile-verify/mobile-followup-approval.sh 补「流式中停止可达」断言：隔离实例会把孤儿 streaming 行判成非流式，所以改用客户端注入——在页面里通过 store（LinearThreadView 用的 tipStreamingId / 会话 store 的 streaming 状态）注入一次流式态，或加一个仅测试路由/查询参数开启的 stub（不得影响生产行为、需门控），然后断言 data-composer-state="stopping"、停止按钮 ≥44×44 且 rect.bottom <= innerHeight、向下滚 600px 后 data-composer-hidden 仍为 false。
  - F-2（必做）：紧凑态保留 📎 附件按钮为一级，只收 ✏️ 草图；spec progress/mobile-shell.md 的裁决表同步写清「紧凑态：追问占位 + 📎 + 发送/停止」。
  - F-4（必做）：等待横幅点击轮转到下一项（记住已跳过的 id），文案改「跳到下一项等你处理」或等价。
  - N-1（必做）：QuestionInput 改为从 app/page.tsx 接 isMobile prop，删掉两个 isMobile === null 占位分支，与一波 S-3 的单一真相源做法一致。
  - N-2（必做）：把「更多设置」抽屉的 [&_button]:min-h-11 收窄到显式控件（或 [&>button]），不再对后代所有 button 生效；实测 ModePicker / ModelPicker / AgentPicker 内部按钮尺寸与合并前一致。
  - F-3、N-3：写进 spec 的「后续 TODO」节，不改代码。
  ③ B-4：合并 + 修复后，五条脚本按 3471→3472→3473→3474→3475 串行跑满（脚本自带互斥锁；跑前 agent-browser close --all；用 env -i HOME=$HOME PATH=$PATH sh <script> </dev/null），加 bunx tsc --noEmit 与 bun test，全绿；连跑两遍。按主题分组 commit，message 引用 F-1/F-2/F-4/N-1/N-2，不 push；不碰三条源分支与 wave1 分支。
- [ ] review-b2: 复核 feat/mobile-wave2：F-1/F-2/F-4/N-1/N-2 真修、合并完整、五条脚本实跑、桌面零回归 | after: fix-b | mode: readonly | kind: claude | keep-seat
  cid: fj-review-b2-e32b
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-b2-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  复核 feat/mobile-wave2（worktree 见契约 workdir）相对 feat/mobile-wave1：你上一份 review（.fenjue/archive/fj-review-b-bcb6/out/review.md）的 F-1/F-2/F-4/N-1/N-2 是否真修且无回归（F-1 的流式注入若走测试门控，核它不影响生产路径）；合并完整性（两条源分支为 ancestor、NewQuestionPicker 冲突解法正确、无改动被吞）；五条脚本在集成 worktree 串行实跑（自带锁，跑前 agent-browser close --all）；桌面 1280×800 零回归再测。结论 out/review.md 首行 verdict: pass|fail，只列可操作问题。只 diagnose 不改文件。
- [ ] fix-b2: 修复核 B2-1（流式测试桩加构建期闸并抽成独立 hook）与 B2-2（模式 radio 恢复 ≥44px，断言回到 >=44） | after: review-b2 | kind: codex | keep-seat
  cid: fj-fix-b2-fe2c
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh scripts/mobile-verify/mobile-followup-approval.sh
  verify: sh scripts/mobile-verify/mobile-new-session.sh
  verify: sh -c 'for p in 3471 3472 3473 3474 3475; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; ! test -d /tmp/trellis-mobile-verify.lock'
  verify: sh -c '! grep -rn "height - 42" scripts/mobile-verify/ >/dev/null'
  在 feat/mobile-wave2 上继续（worktree /Users/smokingmouse/.herdr/worktrees/trellis/feat-mobile-wave2，先 cd）。复核报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-b2-e32b/out/review.md 的两条：B2-1 把 LinearThreadView 里 60 行流式注入效果抽成 hooks/useVerifyStreamingStub.ts（LinearThreadView 只留一行调用），加构建期闸 if (process.env.NEXT_PUBLIC_TRELLIS_VERIFY !== '1') return; 保留 nonce 与 isMobile 闸；mobile-followup-approval.sh 起隔离实例时在 build 与 start 环境里 export NEXT_PUBLIC_TRELLIS_VERIFY=1（注意 NEXT_PUBLIC_ 变量在 build 期内联，脚本若复用已有 .next 需判断该 build 是否带闸——最稳是脚本为本单构建单独 dist 或在缺该标记时强制重 build），并在脚本里加一条反向断言：不带该变量的普通 build 下派发注入事件不生效（可用一次 curl 拉主包 JS 检查不含 trellis-mobile-verify-streaming 字面量作为廉价替代）。B2-2 ModePicker radiogroup 容器改 max-md:h-12 或去掉固定高改由子项 max-md:min-h-11 撑开，实测三个 role=radio ≥44px；mobile-new-session.sh:344-350 的断言恢复为 rect.height >= 44（删除 42 的固化写法）。五条脚本串行两遍全绿 + tsc + bun test；commit 引用 B2-1/B2-2，不 push。
- [ ] review-b3: 复核 B2-1/B2-2：构建期闸生效（普通 build 不含桩）、radio ≥44 且断言恢复、五条脚本实跑、无回归 | after: fix-b2 | mode: readonly | kind: claude | keep-seat
  cid: fj-review-b3-aca7
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-b3-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  复核 feat/mobile-wave2 最新提交（基准 42b9bd8）：你上一份复核（.fenjue/archive/fj-review-b2-e32b/out/review.md）的 B2-1/B2-2 是否真修——普通 build（无 NEXT_PUBLIC_TRELLIS_VERIFY）产物里不含流式注入桩（grep 主包字面量 + 实测派发事件不生效），带闸 build 下脚本流式段仍过；ModePicker 三个 radio 实测 ≥44 且脚本断言为 >=44；增量 diff 无其它改动；五条脚本串行实跑；桌面零回归。结论 out/review.md 首行 verdict: pass|fail。只 diagnose 不改文件。
- [ ] read-later: 卡片级「稍后再读」收藏：节点书签列 + API + 卡片切换 + 侧栏分组 + 手机 overflow/bottom sheet 列表 + spec + 验收脚本 | kind: codex | keep-seat
  cid: fj-read-later-b313
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-read-later.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh scripts/mobile-verify/mobile-followup-approval.sh
  verify: sh -c 'for p in 3471 3472 3473 3474 3475 3476; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; ! test -d /tmp/trellis-mobile-verify.lock'
  verify: sh -c 'test -s progress/read-later.md'
  交付物：卡片粒度的「稍后再读」收藏（用户原话：对学习类项目，临时没时间读的卡片先收藏，之后再读）。worktree 基于 main fc8c901e4（已含手机一二波）。先 bun install --frozen-lockfile。
  一、先写 spec progress/read-later.md（§目标与非目标 / §交互（桌面 + 手机）/ §数据与 API / §决策 / §验收），再实现；三条产品决策已由主控定，写进 spec 不再讨论：D1 列表入口 = 侧栏新增「稍后再读 (N)」分组（N>0 时显示，位于「最近」之上），手机在 overflow「…」加一项「稍后再读 (N)」打开 bottom sheet 列表；D2 打开卡片不自动移除收藏，移除只有两条路：卡片上再点一次切换、列表行的「读完 ✓」；「已读/未读」与「收藏」是两个独立标记；D3 粒度 = 节点（一问一答的卡片），不做会话级/树级收藏。
  二、数据与 API：nodes 表加 bookmarked_at INTEGER NULL（毫秒），迁移按 lib/server/sqlite.ts / repo.ts 现有幂等 ALTER 模式；repo 层 setNodeBookmark(nodeId, on) / listBookmarks({limit}) 跨未归档会话返回 nodeId、sessionId、sessionTitle、question 摘要（≤80 字）、response 摘要（≤120 字，去 markdown）、bookmarkedAt、readAt、status，按 bookmarkedAt 倒序；API：现有节点更新路由加 {bookmarked:boolean}（或 PATCH /api/nodes/:id/bookmark），新增 GET /api/bookmarks?limit=；补 bun test（repo 与 route）。
  三、UI：① 卡片动作：桌面动作区在「标为已读」旁加书签切换（有/无填充两态，aria-label「稍后再读」/「取消稍后再读」）；手机放进卡片「…」菜单（components/TurnCard.tsx MobileResponseActions），44px；乐观更新 + 失败回滚。② 侧栏分组：components/SessionSidebar.tsx 复用「最近」分组的机制（刷新时机与 S133 一致：切会话/列表变更/回前台），行 = 会话标题 · 问题摘要 + 未读点（readAt 为空）+ 行尾「✓ 读完」按钮；点行走现有深链导航到 session+node（同「最近」链行的落点逻辑）；手机 drawer 同样显示该分组，行高 max-md:h-11。③ 手机 overflow（components/MobileOverflowMenu.tsx）加「稍后再读 (N)」项，打开 bottom sheet（复用 ui/Drawer）列出同一列表，行 ≥44px，点行导航并关闭 sheet。④ store：sessionStore 加 bookmarks 状态与 toggle/refresh；N 的角标随列表刷新。
  四、约束：不改「最近」分组现有结构与行为；手机改动只在手机断点下生效，桌面 1280×800 除新增书签按钮与新分组外零变化；新增输入无；所有新增可点控件手机 ≥44px；不发起真实模型 run；不碰 ~/.trellis/data.db 本体、prod 3088/3200、launchd。
  五、验收脚本 scripts/mobile-verify/mobile-read-later.sh（端口 3476，开头加与其它五条逐字一致的互斥锁段，登录在脚本内，agent-browser session 名 mv-read-later，trap 清理）：库副本里挑一个有内容的节点；iPhone 15：打开该卡片 → … → 稍后再读 → 断言按钮切到「取消」态、overflow 项显示 (1)、bottom sheet 行 ≥44 且文案含会话标题 → 点行断言 location 含该 node id → 回列表点「读完」断言计数归 0；1280×800：动作区有书签按钮、侧栏出现「稍后再读 (1)」分组与一行、其它分组数量与改前一致（改前实测写进脚本）、清除后分组消失。已有五条脚本在你的改动后仍须全绿（本单 verify 会跑 slim-shell / touch-targets / followup-approval 三条 + 你的新脚本，串行）。
  六、交付判据：agent-browser close --all; env -i HOME=$HOME PATH=$PATH sh <script> </dev/null 连跑两遍 exit 0；bunx tsc --noEmit；bun test；按主题分组 commit（spec / 迁移+API / UI / 脚本），不 push。
- [ ] review-c: 异源 review 稍后再读 + 顶部随滑隐藏两条分支：迁移幂等与数据正确、API 权限与输入校验、桌面零回归、手机 44px、最近分组未被改坏、脚本真断言 | after: read-later,mobile-header-hide | mode: readonly | kind: claude | keep-seat
  cid: fj-review-c-702d
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-c-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  审 feat/read-later 相对 main 的 diff（worktree 见契约 workdir）。重点：① 迁移幂等（重复启动不报错、旧库无该列时补列）与 listBookmarks 的 SQL（归档会话过滤、摘要截断、排序）；② API 输入校验与鉴权与现有节点路由一致；③ 桌面 1280×800 零回归：除新增书签按钮与「稍后再读」分组外无变化，「最近」分组行为不变；④ 手机：overflow 项与 sheet 行 ≥44、深链落点正确、bottom sheet 焦点与关闭；⑤ 乐观更新失败回滚；⑥ 脚本是否真断言（含清除后分组消失）。可在 worktree 串行实跑 mobile-read-later.sh 与 slim-shell/touch-targets/followup 三条（自带锁，跑前 agent-browser close --all）。结论 out/review.md 首行 verdict: pass|fail，只列可操作问题。只 diagnose 不改文件。
- [ ] ship-c: 合并三波集成分支 feat/mobile-wave3（稍后再读 + 顶部随滑隐藏）并上线；起位前问用户 | after: review-c2 | mode: readonly | kind: codex
  cid: fj-ship-c-6211
  verify: sh -c 'curl -s --noproxy "*" -m 5 http://127.0.0.1:3088/__gate/health | grep -q "\"gate\":\"up\",\"next\":\"ready\""'
  【起位前必须由用户点头】同 ship-b 流程：推 feat/read-later、开 PR、merge、主仓 pull --ff-only、make deploy REF=HEAD（不是 make deploy HEAD）、验活、iPhone 只读冒烟（书签切换 + overflow 计数 + sheet）。ship 类契约起位前先把 commands_forbidden 收窄、目标里写明 blocker 期间不发 result、结算前更新 base_commit。
- [ ] mobile-header-hide: 手机阅读时顶部 header 与标题条随下滑隐藏、上滑恢复，横幅不隐藏，桌面不变（用户 09-06 真机反馈） | kind: codex | keep-seat
  cid: fj-mobile-header-hide-564d
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh -c 'for p in 3471 3472 3473 3474 3475 3476; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; ! test -d /tmp/trellis-mobile-verify.lock'
  交付物：手机阅读时顶部区域随下滑隐藏（用户 09-06 真机反馈：输入区已会隐藏，顶上那段也要能藏，实际阅读时不受其它区域干扰）。worktree 基于 main fc8c901e4（含手机一二波）。先 bun install --frozen-lockfile。
  1. 范围：手机断点、线性阅读视图。随下滑隐藏的顶部区域 = slim header（☰ / 标题 / …）+ 其下的会话/树标题条（LinearThreadView 顶部「PROJECT · 线性 + 标题」那一行）。向上滑动或滚到顶部即恢复；等待审批/提问横幅存在时横幅仍可见（贴到安全区顶部，不随隐藏）；点击屏幕顶部边缘（状态栏区域）也恢复。
  2. 实现：复用 Composer 已有的滚动方向判定（LinearThreadView 里 composerIsHidden 那套阈值/防抖），抽成共享 hook（如 hooks/useScrollHide.ts），header 与标题条用 transform translateY(-100%) + transition 隐藏，隐藏时正文不重排（滚动锚点不跳）；prefers-reduced-motion 下去掉过渡；桌面完全不变（桌面 header 永远 rect.top === 0）。
  3. 安全区：隐藏后正文顶到状态栏下方时仍保留 --safe-top 的不可点区域（正文不压进状态栏，可用同色遮罩条）；恢复时 header 高度仍读 --trellis-header-h。
  4. 验收：扩展 scripts/mobile-verify/mobile-slim-shell.sh：iPhone 15 打开有内容会话，滚 300px 后断言 header 带 data-header-hidden="true" 且 rect.bottom <= 0、标题条不可见、Composer 同时隐藏；回滚 100px 后三者恢复；滚到顶部恢复；有等待横幅的 fixture 会话滚动后横幅 rect.top >= 0 仍可见；1280×800 桌面 header rect.top === 0 且无 data-header-hidden。mobile-safe-area.sh 的 header 安全区断言仍须通过。
  5. 与并行的 feat/read-later 分支共用 LinearThreadView.tsx / Header.tsx：改动保持局部（新增 hook 文件 + 少量 className/data 属性），不重排无关代码、不整文件格式化。
  6. 交付判据：agent-browser close --all; env -i HOME=$HOME PATH=$PATH sh <script> </dev/null 连跑两遍 exit 0；bunx tsc --noEmit；bun test；commit 不 push；blocker 期间不发 result。
- [ ] fix-c: 三波集成：合并 read-later 与 header-hide 到 feat/mobile-wave3，修 R-1/R-2/R-3/R-4/H-1/H-2，七条脚本整套重跑 | after: review-c | kind: codex | keep-seat
  cid: fj-fix-c-4fb9
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh -c 'git merge-base --is-ancestor feat/read-later HEAD && git merge-base --is-ancestor feat/mobile-header-hide HEAD'
  verify: sh scripts/mobile-verify/mobile-safe-area.sh
  verify: sh scripts/mobile-verify/mobile-touch-targets.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh scripts/mobile-verify/mobile-followup-approval.sh
  verify: sh scripts/mobile-verify/mobile-new-session.sh
  verify: sh scripts/mobile-verify/mobile-read-later.sh
  verify: sh -c 'for p in 3471 3472 3473 3474 3475 3476; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; ! test -d /tmp/trellis-mobile-verify.lock'
  交付物：三波集成分支 feat/mobile-wave3（你的新 worktree 已从 main fc8c901e4 建好；先 cd 过去，bun install --frozen-lockfile）。
  ① 按顺序 git merge --no-ff feat/read-later → feat/mobile-header-hide（review 实测零文本冲突）。
  ② 在集成结果上修 review 报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-c-702d/out/review.md 的问题：
  - R-1（必做）listBookmarks 过滤被雪藏的树：雪藏标记只在树根 hidden_at，子节点恒 NULL，所以要解析到树根再过滤（复用 treeRootIdOf 或递归 CTE 沿 parent_id 到根），同步更新 spec progress/read-later.md「数据与 API」；补一条单测（雪藏树里的收藏不出现在列表与计数）。
  - R-2（必做）refreshBookmarks 只同步返回窗口内的 id，窗口外节点保持本地 bookmarkedAt 不动；GET /api/bookmarks 额外返回 total，侧栏/overflow 计数用 total，列表超过 limit 时行尾标注「还有 N 条」；补单测/断言。
  - R-3（必做）摘要截断补「…」。
  - R-4（必做）未读点改 role="img" 或 sr-only 文本；BookmarksDrawer 打开时焦点移到关闭按钮、关闭后归还触发按钮。
  - H-1（必做）隐藏/恢复时在同一帧补偿 scrollRef.scrollTop（∓ 位移量），阅读锚点视觉不跳；mobile-slim-shell.sh 新增断言：隐藏前后同一节点的 rect.top 变化 ≤ 2px（或 scrollTop 差值等于位移量）。
  - H-2（必做）[data-header-reveal] 高度下限改 max(var(--safe-top), 24px)，并允许点击被隐藏标题条区域恢复。
  - H-3、R-2 的 >50 条脚本场景：写进 spec 的「后续 TODO」，不改代码。
  - 脚本显式化依赖：mobile-read-later.sh 每次点「更多功能」前先 scrollTop=0（或点 [data-header-reveal]）。
  ③ 在集成 worktree 串行跑满七条脚本（3471→3476 六条 + mobile-read-later 已含；即 safe-area / touch-targets / slim-shell / followup-approval / new-session / read-later），脚本自带锁；**不要 agent-browser close --all**，只 close 自己的 session；用 env -i HOME=$HOME PATH=$PATH sh <script> </dev/null 连跑两遍全绿；bunx tsc --noEmit；bun test。按主题分组 commit（merge / R-1 R-2 / R-3 R-4 / H-1 H-2 / 脚本），message 引用编号，不 push；不碰两条源分支。blocker 期间不发 result。
- [ ] review-c2: 复核 feat/mobile-wave3：R-1/R-2/R-3/R-4/H-1/H-2 真修、合并完整、七条脚本实跑、桌面零回归 | after: fix-c | mode: readonly | kind: claude | keep-seat
  cid: fj-review-c2-5e39
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-c2-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  复核 feat/mobile-wave3（worktree 见契约 workdir，正式 worktree、可构建）相对 main：你上一份 review（.fenjue/archive/fj-review-c-702d/out/review.md）的 R-1/R-2/R-3/R-4/H-1/H-2 是否真修且无回归（R-1 用雪藏树 fixture 实测；R-2 用 >limit 的收藏数实测计数与本地状态；H-1 实测隐藏前后锚点位移 ≤2px）；合并完整性（两条源分支为 ancestor、无改动被吞）；七条脚本在集成 worktree 串行实跑（自带锁，不要 close --all）；桌面 1280×800 零回归。结论 out/review.md 首行 verdict: pass|fail，只列可操作问题。只 diagnose 不改文件。
- [ ] branch-chain-diag: 手机分链表现不一致：只读诊断——复现所有分链路径、定位根因、给修法与断言 | mode: readonly | kind: codex | keep-seat
  cid: fj-branch-chain-diag-462d
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-branch-chain-diag-*/out/diagnosis.md 2>/dev/null | head -1); test -n "$f" && grep -q "根因" "$f"'
  verify: sh -c '! lsof -nP -iTCP:3477 -sTCP:LISTEN >/dev/null 2>&1'
  只读诊断单（不改任何 git 跟踪文件，产物落本单 out/）。用户真机反馈（Safari 主屏 standalone，手机一二波已上线）：「当我开一条分链的时候，这条分链的表现和原有那条链的 UI 展示、交互就不一样了，不是一个稳定的东西，不确定怎样触发。」你的任务：在 worktree /Users/smokingmouse/.herdr/worktrees/trellis/feat-mobile-wave3（含全部手机改动，先 cd，bun install --frozen-lockfile）上复现并定位根因。
  步骤：① 用真库在线备份起隔离实例（HOME=/tmp/trellis-diag-branch，TRELLIS_DB_PATH 指向副本，TRELLIS_LARK=off，TRELLIS_AUTH_PASS=diag，端口 3477，bun --bun run build 后 bun --bun run start -- -p 3477；副本里 UPDATE tasks SET enabled=0; UPDATE lark_bots SET enabled=0, app_secret='invalid'），agent-browser 独立 session mv-diag-branch，device "iPhone 15"（不要 close --all）。② 在一个有多轮内容的会话里，逐一走所有能产生「分链 / 新分支」的路径，每条路径前后各截一张图并记录状态：a 选中回答文字 → 追问（BranchPopover）→ 发送前后；b 卡片动作区的「分支」按钮；c 「编辑问题（会新建一个分支重问）」；d 新树（overflow → 思维树 → 新树 / NewQuestionPicker）；e 从侧栏「最近」分组点一条非当前链的链行；f 深链 /?session=&node= 落到分链上的节点。不发起真实模型 run：走到发送前即止；若某路径必须发送才产生新节点，则用 SQL 在副本里直接插入一个分链节点（parent_id 指向现有节点、sibling_index+1）再刷新，模拟「分链已存在」。③ 对每条路径比较分链与原链的：视口/布局（是否仍是线性视图、header 是否是 slim header、是否出现 TreePanel/画布、Composer 是否紧凑态、data-header-hidden 状态、是否落入桌面壳 trellis-desktop-mode）、滚动隐藏是否仍工作、卡片动作区是否一致、URL 参数、localStorage 的 trellis-view:<session> 值（activeNodeId / viewMode）。④ 读代码定位：sessionStore / app/page.tsx / LinearThreadView / Canvas / TreePanel 里所有会改 viewMode、切换视图、切换 activeNodeId、重挂载线性视图的路径；useIsMobile 与 isMobile prop 在分链切换时是否稳定；useScrollHide 的模块级单例在视图重挂载时是否残留隐藏态（这是 review 记过的 H-3 风险）；新建分支/新树时是否有「切到画布/树视图」的桌面默认逻辑没有手机门控。
  交付 out/diagnosis.md：§复现（哪条路径、稳定触发条件、截图路径）；§根因（file:line 与因果链）；§修法（具体改动点 + 为何不会回归桌面）；§验证方案（可加进哪条 mobile-verify 脚本的断言）。若多个路径都异常，分别列。找不到复现也要写清楚试过什么、观察到什么。结束杀 3477 实例、close 自己的 session。
- [ ] branch-chain-fix: 按诊断修手机分链不一致，补断言，基于上线后的 main | after: branch-chain-diag,ship-c | kind: codex | keep-seat
  cid: fj-branch-chain-fix-d0ed
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh scripts/mobile-verify/mobile-followup-approval.sh
  verify: sh -c 'for p in 3471 3472 3473 3474 3475 3476 3477; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; ! test -d /tmp/trellis-mobile-verify.lock'
  按 branch-chain-diag 的 out/diagnosis.md 修根因（worktree 基于上线后的 main），把诊断给出的断言加进对应 mobile-verify 脚本；桌面零回归；交付判据同前（脚本连跑两遍、不 close --all、blocker 期间不发 result）。
- [ ] review-d: 异源 review 分链修复：F1–F4 真修、桌面零回归、脚本真断言 | after: branch-chain-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-review-d-43ac
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-d-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  审 feat/mobile-branch-chain 相对 main 的 diff：以诊断 .fenjue/archive/fj-branch-chain-diag-462d/out/diagnosis.md 为规格核 F1–F4 真修（实测诊断里 a–f 六条路径与 e 的 canvas 触发条件）；桌面 1280×800 零回归（F1/F2/F3 门控、F4 只改 query 且不加历史）；URL 同步与 deep-link 入站的竞态（hydrate 旧 session 是否会覆盖入站参数）；脚本真断言；只 close 自己的 session。结论 out/review.md 首行 verdict: pass|fail。只 diagnose 不改文件。
- [ ] ship-d: 合并 feat/mobile-branch-chain 并上线；起位前问用户 | after: review-d2 | mode: readonly | kind: codex
  cid: fj-ship-d-1089
  verify: sh -c 'curl -s --noproxy "*" -m 5 http://127.0.0.1:3088/__gate/health | grep -q "\"gate\":\"up\",\"next\":\"ready\""'
  【起位前必须由用户点头】同 ship-c 流程（make deploy REF=HEAD、blocker 期间不发 result、起位前收窄 commands_forbidden、结算前更新 base_commit）。
- [ ] fix-d: 修 review-d：D-1 认下「编辑重问两端统一聚焦新兄弟」并补桌面断言 + 记决策；D-2 落点判定改语义 useIsMobile；D-3 无 session 时清 query；D-4 记 Cancel 取舍 + 断言 | after: review-d | kind: codex | keep-seat
  cid: fj-fix-d-3071
  verify: bunx tsc --noEmit
  verify: bun test
  verify: sh scripts/mobile-verify/mobile-branch-chain.sh
  verify: sh scripts/mobile-verify/mobile-slim-shell.sh
  verify: sh -c 'for p in 3471 3472 3473 3474 3475 3476 3477 3478; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && exit 1; done; ! test -d /tmp/trellis-mobile-verify.lock'
  verify: sh -c 'grep -q "编辑" progress/mobile-shell.md'
  在 feat/mobile-branch-chain 上继续（worktree /Users/smokingmouse/.herdr/worktrees/trellis/feat-mobile-branch-chain，先 cd）。review 报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-d-43ac/out/review.md：D-1 主控裁决 = 认下统一——「编辑问题重问」在桌面与手机都聚焦新兄弟（这是用户明确动作，旧的桌面「留在原链」是 anchor 耦合的副产物，不是设计）；代码不改，但在 progress/mobile-shell.md 记一条决策，并给 mobile-branch-chain.sh 补 1280×800 的 edit 落点断言（对 anchored 节点 re-ask 后新兄弟成为 active；mock provider 已有，桌面视口复用）。D-2 BranchPopover 的 focusNew 判定改用语义 useIsMobile()（组件内已有 isMobile），不用物理视口。D-3 app/page.tsx 同步 effect 在 !sessionId 时把 session/node 两个参数 delete 后 replaceState（新会话首屏刷新不回旧链），脚本补一条断言。D-4 F2 取舍记入 progress/mobile-shell.md（手机「＋ 新树」先关树 sheet，Cancel 落到线性），脚本补 Cancel 后 [data-mobile-tree-sheet] 不存在且仍是 linear 的断言。交付判据不变（两条脚本连跑两遍、不 close --all、blocker 期间不发 result），commit 引用 D 编号，不 push。
- [ ] review-d2: 复核 D-1 决策落档 + 桌面 edit 断言、D-2/D-3/D-4 真修、脚本实跑 | after: fix-d | mode: readonly | kind: claude | keep-seat
  cid: fj-review-d2-eef2
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-review-d2-*/out/review.md 2>/dev/null | head -1); test -n "$f" && head -1 "$f" | grep -q -E "^verdict: (pass|fail)"'
  复核 feat/mobile-branch-chain 最新提交：主控已裁决 D-1 为有意统一（桌面 edit 也聚焦新兄弟），只核决策是否写进 progress/mobile-shell.md 且脚本有 1280×800 edit 落点断言；D-2 改用 useIsMobile；D-3 无 session 清 query（实测新会话首屏 URL 无 session/node 参数）；D-4 决策落档 + Cancel 断言；两条脚本实跑；桌面 header rect.top=0。结论 out/review.md 首行 verdict: pass|fail。只 diagnose 不改文件。
- [ ] wt-diag: 诊断 Trellis 侧栏 worktree 展示逻辑：合成 25+ worktree 项目在隔离实例复现、逐条列规则与不一致点（带 file:line 与截图）、写根因与 2-3 个重构方案供用户拍板 | mode: readonly | keep-seat
  cid: fj-wt-diag-a677
  只读：不改仓库文件，产物落 out/；合成仓与隔离实例只在 /tmp 与 3479 端口；结束清干净
- [ ] wt-fix-a: 方案 A 止血：realpath 归一与存量去重、已合并判定只认第二父、清理准入加无活跃会话闸、扫描登记不写 last_used_at 且排序与 Picker 最近只吃会话活跃度、灰标签改 detached、prune 在主 checkout 跑；配单测 | after: wt-diag | kind: codex
  cid: fj-wt-fix-a-65ed
  写入 .fenjue/archive/fj-wt-diag-a677/out/diagnosis.md 方案 A；worktree 隔离；桌面零回归
- [ ] wt-review-a: 异源 review 方案 A：A1-A6/A15 真修、迁移安全、桌面零回归、单测真断言 | after: wt-fix-a | mode: readonly | kind: claude | keep-seat
  cid: fj-wt-review-a-13de
- [ ] wt-ship-a: 合并方案 A 分支并上线；起位前问用户 | after: wt-review-a3 | mode: readonly | kind: codex
  cid: fj-wt-ship-a-69b3
- [ ] wt-fix-a2: 返工方案 A：#1 已合并判定改为 is-ancestor 且 tip 不在 base 的 first-parent 链上（加 update-branch 与 rebase 用例）；#2 只有 worktree-scan 登记写 NULL、UI 新建 worktree 视为一次真实使用；#3 Picker 最近三路合并取 max；#4 清理预演会话数与侧栏同口径；#5 prune 落点先 rev-parse --git-common-dir | after: wt-review-a | kind: codex
  cid: fj-wt-fix-a2-c4ed
- [ ] wt-review-a2: 复核返工：#1-#5 真修、反例用例进单测、桌面零回归 | after: wt-fix-a2 | mode: readonly | kind: claude | keep-seat
  cid: fj-wt-review-a2-6abd
- [ ] wt-fix-a3: 二次返工：ensureWorkspaceForPath 只对 trellis 来源写 last_used_at=now，discovered 与 worktree-scan 写 NULL；补「backfill 建的 discovered 行按会话 updated_at 排、不按插入序」单测 | after: wt-review-a2 | kind: codex
  cid: fj-wt-fix-a3-cc07
- [ ] wt-review-a3: 终审：复核二次返工与 A4 排序口径、桌面零回归 | after: wt-fix-a3 | mode: readonly | kind: claude | keep-seat
  cid: fj-wt-review-a3-a97d
- [ ] herdr-mobile-research: 调研：Herdr 官方与社区里手机端接管 TUI agent 会话的现成方案（含 Claude Code Remote Control、Happy、Omnara、opencode 等），比较接管方式、审批、多坐席、codex 支持，给 Trellis 打通 Herdr 的借鉴与替代判断 | mode: readonly | kind: claude
  cid: fj-herdr-mobile-research-c725
- [ ] orca-research: 调研 Orca（Stably AI，本机 /Applications/Orca.app 1.4.143）如何解决「UI 接管 TUI agent 会话 + 手机/远程」：hooks 架构、内容来源、输入回路、远程与手机方案，给 Trellis 的借鉴 | mode: readonly | kind: claude
  cid: fj-orca-research-e830
- [ ] hb-probe: 探针：从 Bun 连 herdr.sock（协议 19）拿 snapshot 与订阅事件、agent_session→transcript 路径映射（claude 与 codex 各一例）、经 socket 或 CLI 注入文本的可行路径、Herdr 未运行时的行为、launchd 环境下 socket 可达性、codex rollout jsonl 结构样本；产出 API 形状与结论供 hb-core | mode: readonly | kind: claude
  cid: fj-hb-probe-fdb5
- [ ] hb-hooks: hook 接收端：scripts/trellis-hook.sh（sh+curl、端点文件放端口与 token、永不阻塞 exit 0）+ /api/hooks/claude 校验 token、事件归一化四态 working/blocked/waiting/done + interactivePrompt（PermissionRequest、PreToolUse AskUserQuestion、Stop/StopFailure、UserPromptSubmit、SubagentStart/Stop）、session_id/transcript_path/cwd 绑定记录、幂等安装器（写 ~/.claude/settings.json，--dry-run，不碰 Orca 条目）、单测 | kind: claude
  cid: fj-hb-hooks-89b2
  worktree feat/herdr-hooks（基于 feat/herdr-bridge）
- [ ] hb-codex-transcript: codex rollout jsonl 解析：~/.codex/sessions/**/rollout-*.jsonl（session_meta/response_item/event_msg/turn_context）→ 现有 cli-sync transcript 模型，按 session id 定位文件，脱敏 fixture + 单测 | kind: codex
  cid: fj-hb-codex-transcript-6d23
  worktree feat/herdr-codex-transcript（基于 feat/herdr-bridge）
- [ ] hb-core: 服务端 HerdrClient：连 socket 取 snapshot + 订阅事件维护舰队模型（workspace→tab→pane→agent 状态与 agent_session）；/api/herdr/fleet（含轮询或 SSE）、/api/herdr/panes/[id]/input（经 Herdr 送文本，bracketed paste + 延迟回车）、pane→provider session→transcript 绑定表并自动挂到 cli-sync 只读；Herdr 出生会话标记为不可由 Trellis runtime resume；重开动作（pane split + claude --resume）；Herdr 缺席时优雅降级；单测 | after: hb-probe | kind: codex
  cid: fj-hb-core-18c2
  worktree feat/herdr-core（基于 feat/herdr-bridge）
- [ ] hb-integrate: 把 feat/herdr-hooks、feat/herdr-codex-transcript、feat/herdr-core 合入 feat/herdr-bridge，解冲突，tsc/bun test/既有 mobile-verify 全绿 | after: hb-hooks,hb-codex-transcript,hb-core | kind: codex
  cid: fj-hb-integrate-843a
  在 feat/herdr-bridge worktree 内操作，只合本地分支
- [ ] hb-ui: 前端：侧栏「Herdr」分组（工作区→pane，状态点，blocked 置顶）；Herdr 会话视图（transcript 渲染、输入框经 Herdr 送出、pane 死则只读 + 在 Herdr 里重新打开、Claude pane 的 Remote Control 深链位）；审批/AskUserQuestion 卡片（数据形状抄 Orca：interactivePrompt=tool_input、approval{tool,summary}，回答走送键，input lease）；手机精简壳适配；测试门控 stub + scripts/mobile-verify/mobile-herdr.sh（3480） | after: hb-integrate | kind: codex
  cid: fj-hb-ui-b1a3
  在 feat/herdr-bridge worktree 内
- [ ] hb-review: 异源 review：单驱动规则（Trellis 永不 resume Herdr 出生会话）、token 与 socket 安全、Herdr 缺席降级、桌面零回归、脚本真断言 | after: hb-ui | mode: readonly | kind: claude | keep-seat
  cid: fj-hb-review-4f44
- [ ] as-design: agent-server 设计：docs/agent-server/{README,protocol,trellis-migration}.md——目标与非目标、架构（daemon 独占引擎、item 日志、turn 队列、审批 broker、attach 快照）、协议（方法/通知/反向请求/item 种类/错误码/版本，取 codex app-server v2 的最小子集命名）、Trellis 迁移映射与风险 | kind: claude
  cid: fj-as-design-2d7f
  sm-toolkit worktree feat/agent-server；只写 docs，不建包；先读 packages/agent、progress/orchestra-rfc.md、trellis lib/llm 与 run-bus、/tmp/codex-app-server-schema
- [ ] as-core: packages/agent-server 核心：zod 协议类型与 JSON schema 导出、ThreadManager（session→唯一引擎进程登记）、ItemLog（sqlite 持久化 + 快照）、TurnQueue（一 thread 一轮、排队与 steer）、ApprovalBroker（广播、先答生效、其余撤卡）、进程内 Server 与 MockBackend/ClaudeBackend 适配、单测 | after: as-design | kind: codex
  cid: fj-as-core-4506
- [ ] as-transport: 传输与 daemon：NDJSON unix socket + websocket，多客户端 fan-out，attach 取快照后续通知，token 鉴权，daemon start/stop/status CLI，断线重连语义，假客户端集成测试 | after: as-core | kind: codex
  cid: fj-as-transport-3bcf
- [ ] as-codex-engine: codex 引擎适配：经 codex app-server 协议（或现有 CodexBackend）接入同一 thread/turn/item 模型，审批与 requestUserInput 对齐，单测 | after: as-core | kind: codex
  cid: fj-as-codex-engine-8a92
- [ ] as-tui: 薄 TUI 客户端 apps/agent-tui：thread 列表、attach 流式渲染 item、输入、审批与提问卡、--attach <thread>，在 Herdr 内主动 pane.report_agent_session 并按 Herdr 约定报状态 | after: as-integrate | kind: codex
  cid: fj-as-tui-5277
- [ ] as-review: 异源 review agent-server：单引擎不变量、队列与审批并发、断线与重连、持久化一致性、协议与文档一致 | after: as-integrate,as-tui | mode: readonly | kind: claude | keep-seat
  cid: fj-as-review-05ca
- [ ] hb-fix: 修 review 全部发现：P0-1 agent.wait 独立超时、ETIMEDOUT 不 markDown、send 与 wait 解耦；P0-2 upsert 带 origin（herdr 优先）且闸改判 herdr_sessions 真源；P0-3 readText 认 result.read.text 并显式 lines；P1-1 fake-herdr 按真形状与时序、推事件；P1-2 撤卡按 tool 匹配；P1-3 hook 状态陈旧度与表清理；P1-4 hooks/state 投影 + ETag + 入库截断；P1-5 按键映射对真 TUI 校准并注释；P1-6 reopen 只 split 无 agent 的 pane；P1-7 herdr 镜像会话 kind 隐出主列表；P2-1…P2-8 | after: hb-review | kind: codex
  cid: fj-hb-fix-dce3
- [ ] hb-review2: 复核返工：用上一轮 repro 脚本原样重打 P0/P1，抽查 P2，桌面零回归 | after: hb-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-hb-review2-25ba
- [ ] as-integrate: 把 feat/agent-server-transport 与 feat/agent-server-codex 合入 feat/agent-server，解冲突，typecheck 与全部 bun test 绿 | after: as-transport,as-codex-engine | kind: codex
  cid: fj-as-integrate-4ced
- [ ] hb-fix2: 修复核残留 R1–R6：R1 单驱动真源沿 cli_lineages 展开（闸、herdr_alive、findHerdrPaneForSession、reopen 同一解析）+ 双 sid 回归；R2 splitAndResume 用 binding.cwd；R3 卡片带 agent_id 比对；R4 父卡复位条件改按 stash 内容/卡片栈；R5 多问题卡真机校准并补 E2E；R6 忙时入队立即 202 不挂 HTTP | after: hb-review2 | kind: codex
  cid: fj-hb-fix2-505f
- [ ] hb-review3: 终审：R1–R6 用 review2 的反例原样重打，桌面零回归 | after: hb-fix2 | mode: readonly | kind: claude | keep-seat
  cid: fj-hb-review3-8ad6
- [ ] hb-verify-instance: 起真机验证实例：feat/herdr-bridge 独立 dist 构建，真 HOME + 真库 .backup 副本 + 3490 端口 + 与 prod 相同鉴权 + TRELLIS_LARK=off，装 Claude hooks（备份、可卸载），Tailscale/LAN 可达，交付访问说明 | after: hb-review3 | mode: readonly | kind: codex
  cid: fj-hb-verify-instance-a5bb
- [ ] hb-fix3: 修终审 N1：排队链失败不连坐（前一条 rejection 不传给后一条）、composer 收到 delivered 再清空或失败时还回文本；补单测与 E2E | after: hb-verify-instance | kind: codex
  cid: fj-hb-fix3-b6be
- [ ] as-fix: 修 agent-server review：§一 安全洞 thread/start.env 覆盖 PATH/ANTHROPIC_*（从 v1 params 删除 env 或白名单+顺序）；§二 契约缺口：attach sinceSeq 不丢 inProgress 后 completed 的 item（服务端按 item 完成 seq 或文档补规范）、check-codex-alignment.ts 落地、codex 未知 item type 不拆 thread；测试非幂等；§三 建议项；review 探针转正式单测 | after: as-review | kind: codex
  cid: fj-as-fix-2a29
- [ ] as-review2: 复核 agent-server 返工：用 review 的探针原样重打，安全洞与契约缺口必须打不穿 | after: as-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-as-review2-29f0
- [ ] as-fix2: 修 review2 的 N1：error 通知在首轮前 turnId 为空串会让所有客户端解析失败掉线——mapper 在无 turnId 时省略字段（协议里 turnId 可选）且引擎在非 active 时忽略/降级早到的 tool_result；client 对畸形通知只丢弃该条不断线；补探针 12/13 为单测 | after: as-review2 | kind: codex
  cid: fj-as-fix2-d7d9
- [ ] hb-nest: 侧栏 Herdr 分组改为「仓库 → worktree → 会话」嵌套（与项目树同一套行组件与折叠记忆），非 git 工作区平铺；等待/阻塞状态向上冒泡计数；手机抽屉同样；fleet 暴露 worktree 元数据与分支；E2E 假 Herdr 加同仓多 worktree 场景 | kind: codex
  cid: fj-hb-nest-a06c
  分支 feat/herdr-bridge；不重建 3490 实例
- [ ] hb-nest-review: 复核嵌套分组：结构正确、折叠记忆、冒泡计数、手机抽屉、桌面零回归 | after: hb-nest | mode: readonly | kind: claude | keep-seat
  cid: fj-hb-nest-review-2123
- [ ] hb-instance-rebuild: 用最终 HEAD 重建 3490 验证实例（同 env、同库副本、同端口，先停旧进程再起），核 gate 与 Tailscale/LAN 可达 | after: hb-nest-review | mode: readonly | kind: codex
  cid: fj-hb-instance-rebuild-8546
- [ ] as-smoke: agent-server 真引擎实跑：起 daemon，真 claude（Opus）与真 codex（gpt-6-astra、普通档）各一个 thread 走完整链路——turn、审批请求（命令执行与文件改动）、双客户端 attach、断线重连回放、interrupt 与排队——记录实际帧与耗时，出 smoke 报告 | mode: readonly | kind: codex
  cid: fj-as-smoke-1076
  verify: sh -c 'f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-as-smoke-*/out/smoke.md 2>/dev/null | head -1); test -n "$f" && grep -q "^结论" "$f"'
- [ ] hb-nest-fix: 返工嵌套复核 P1-1 排序（主 checkout 置顶、仓库与 worktree 按名稳定排序、不随 pane 状态重排）、P1-2 新 workspace 立即拿到 worktree 元数据（不等 60 秒快照）、P2-1 分支解析失败不硬编码 main、P2-2 待处理角标仅折叠时显示（与项目树口径一致）、P2-3 checkout_path 尾斜杠、P2-4 分支解析失败结果缓存且 git 不在事件回调里同步跑；每条补单测或 E2E 断言 | after: hb-instance-rebuild | kind: codex | keep-seat
  cid: fj-hb-nest-fix-115b
- [ ] hb-nest-review2: 复核嵌套返工：用 review 的反例原样重打 P1-1/P1-2/P2-1～P2-4，桌面零回归 | after: hb-nest-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-hb-nest-review2-9017
- [ ] hb-instance-rebuild2: 嵌套返工通过后再次用最终 HEAD 重建 3490 实例（同配方） | after: hb-nest-review3 | mode: readonly | kind: codex
  cid: fj-hb-instance-rebuild2-2970
- [ ] as-migrate-1: Trellis 影子模式（迁移第一步，独立分支 feat/agent-server-client，不改现有链路）：lib/server/as-client.ts 连 daemon（initialize、thread/list、thread/attach、sinceSeq 回放）、/api/as/threads 与 stream 路由、只读 ThreadLogView 页面、instrumentation 建连失败只 warn；验收：真 daemon 起 codex thread，Trellis 页面实时看到同一份 item 日志，断线重连无缺无重 | kind: codex | keep-seat
  cid: fj-as-migrate-1-84a5
- [ ] as-fix3: 修真引擎实跑发现的 P2-1（codex userAgent 前缀只认 codex/codex-cli，真实为 sm_agent_server/0.153.4 导致版本误报 unknown）并补真实字符串单测；用带路径校验的客户端在 /tmp 补跑一次 Claude 文件改动审批（P1-1 未验收项，≤2 turn，模型显式 sonnet） | kind: codex
  cid: fj-as-fix3-f047
- [ ] as-migrate-1-review: 复核 Trellis 影子模式：只读观察不越权、鉴权闸、SSE sinceSeq 续传无缺无重、重连、Turbopack 本地包适配、手机可用、现有链路零改动 | after: as-migrate-1 | mode: readonly | kind: claude | keep-seat
  cid: fj-as-migrate-1-review-7d06
- [ ] as-migrate-1-fix: 修影子模式复核 P0-1 绝对路径依赖（改为 vendor 内置构建产物 + 同步脚本，干净 clone 可装可建，去掉承重 overrides）、P1-1/P2-5 prepare 脚本缺失即跳过并挪到 build 前置、P1-2 观察者默认不启动（TRELLIS_AS=on 或配置 socket 才起）+ 指数退避 + 只报首末条、P1-3 只在 running 时轮询且无变化不推、P2-1 closed 自愈、P2-2 渲染 error/turn 通知、P2-3 贴底跟随、P2-6 首帧不计背压 | after: as-migrate-1-review | kind: codex | keep-seat
  cid: fj-as-migrate-1-fix-31ae
- [ ] as-migrate-1-review2: 复核影子模式返工：用 review 的复现脚本原样重打 P0-1、P1-1～P1-3、P2-1～P2-6，干净 clone 装建通过 | after: as-migrate-1-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-as-migrate-1-review2-c179
- [ ] hb-nest-fix2: 修二次复核 N1：herdr-client 把「payload 缺 worktree 字段」误当元数据未知，非 git workspace 每条 workspace_updated 都强制全量 session.snapshot——改为只在本地不认识该 workspace 或元数据确实变化时才 resync，补单测 | after: hb-nest-review2 | kind: codex | keep-seat
  cid: fj-hb-nest-fix2-238c
- [ ] hb-nest-review3: 复核 N1 返工：用 review2 的风暴反例原样重打，六条旧项不回退，桌面零回归 | after: hb-nest-fix2 | mode: readonly | kind: claude | keep-seat
  cid: fj-hb-nest-review3-72fe
- [ ] as-migrate-1-polish: 收尾影子模式复核遗留 N1–N9（vendor 去 source map、附 LICENSE、依赖表从上游 manifest 生成、脚本默认路径去用户名、E2E 脚本去掉一次性任务目录、TRELLIS_AS 文档与 .env.example、TRELLIS_AS=off 硬关闸、退避期可手动触发重连、底部轻点不关跟随）；P1-3R 记 backlog 不修 | after: as-migrate-1-review2 | kind: codex | keep-seat
  cid: fj-as-migrate-1-polish-60a6
- [ ] doc-write: 《Trellis 当前架构介绍》writecraft 成稿（Gemini，按已拍板 Brief，产 article.md + overview.svg + plan/verify/sources） | mode: readonly | kind: claude | keep-seat
  cid: fj-doc-write-d187
- [ ] doc-review: write-tech-design 六维审阅 + writecraft 证伪复核（Opus，异源），出 P0/P1/P2 清单 | after: doc-write | mode: readonly | kind: claude | keep-seat
  cid: fj-doc-review-66bc
- [ ] doc-fix: 按审阅清单改稿并报 diff（复用写手） | after: doc-review | mode: readonly | kind: claude | keep-seat
  cid: fj-doc-fix-0740
- [ ] doc-feishu-prep: 按 lark-doc 规范把成稿转成飞书 XML（编号标题、画板 mermaid/svg），只产文件不建文档；建文档前主控出预览卡等用户字面确认 | mode: readonly | kind: claude
  cid: fj-doc-feishu-prep-d29e
- [ ] doc-review2: 复审改稿：P0/P1 逐条复核、抽核引用、SVG 与 Mermaid 重渲 | after: doc-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-doc-review2-544f
- [ ] doc-feishu-final: 用终稿重跑 md2lark 产出最终 feishu.xml，--dry-run 比对请求体；不建文档 | after: doc-fix2 | mode: readonly | kind: claude | keep-seat
  cid: fj-doc-feishu-final-aea6
- [ ] doc-fix2: 终稿收尾：复审剩余 4 条 P1 + 5 条 P2 全修（行号错引、SVG 穿框压字、跨仓路径补仓库名、反引号、口令措辞、悬空引用、§8 读法、表名行号配对） | after: doc-review2 | mode: readonly | kind: claude | keep-seat
  cid: fj-doc-fix2-470f
- [ ] as-parity-probe: Claude Code 原生功能对齐清单：逐项分 引擎层已有(headless 协议证据) / 壳层要画(agent-tui) / 真做不到，按用户本机近 60 天 transcript 里的实际使用频率排追平顺序，并核 daemon 当前透传了哪些 | mode: readonly | kind: claude
  cid: fj-as-parity-probe-a5c7
- [ ] as-dogfood-design: fj 坐席改走 agent-tui 的方案：daemon 常驻方式、每坐席一 thread、契约作首轮注入、审批策略等价 -a never、Herdr agent_status 与 fj mail 兼容、settle/verify 不变、回滚开关；给出实现拆解与退出标准 | mode: readonly | kind: codex
  cid: fj-as-dogfood-design-082e
- [ ] as-fix4: 修 claude 引擎致命项：未知 control_request（request_user_dialog / MCP elicitation 等）在 claude.ts 直接 throw 杀会话——改为回 deny 或 error response 并上抛可观测事件；prompt_suggestion 进忽略白名单；补 fake-child 单测 | kind: codex
  cid: fj-as-fix4-d8f7
- [ ] as-foundation: AS 协议与 claude 引擎打底：engineEvent 通知原样上抛 system 子类型（hooks/local_command/api_retry/model_fallback/memory/rate_limit，spawn 加 --include-hook-events）、thread/engineControl 直通 control_request（白名单+响应映射）、权限模式全集（default/acceptEdits/plan/bypass/dontAsk）与 thread/permission/set → set_permission_mode、--effort 透传与热切、子 agent 正文转发（--forward-subagent-text → subAgent item）、bash 输入类型、compact 触发；schema/zod/protocol.md/单测 | after: as-fix4 | kind: codex | keep-seat
  cid: fj-as-foundation-e723
- [ ] tui-sessions: agent-tui 会话管理：/new（对齐 /clear）、/threads 选择器（列表/切换 attach）、/fork、/resume、daemon 重启自动重连、状态栏显示 thread/cwd/model/权限模式；PTY E2E | kind: codex | keep-seat
  cid: fj-tui-sessions-b9d0
- [ ] tui-input: agent-tui 输入形态：图片输入（路径附件 + macOS 剪贴板）、@ 文件本地模糊补全、斜杠/skill 补全（本地扫 ~/.claude/skills + 内建命令）、多行输入；PTY E2E | kind: codex | keep-seat
  cid: fj-tui-input-3d46
- [ ] as-foundation-review: 复核打底：协议兼容性（旧客户端不掉线）、engineControl 白名单安全、权限模式切换真打到 CLI、事件透传不丢不重、fake-child 反例 | after: as-foundation | mode: readonly | kind: claude | keep-seat
  cid: fj-as-foundation-review-29a6
- [ ] tui-sessions-review: 复核会话管理：真 PTY 打 /new /threads /fork /resume 与断线重连 | after: tui-sessions | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-sessions-review-3e10
- [ ] tui-input-review: 复核输入形态：图片/@ 补全/斜杠补全/多行 真 PTY 反例 | after: tui-input | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-input-review-dfc8
- [ ] tui-modes: agent-tui 模式面板：Shift+Tab 权限模式热切与 plan mode（plan item 渲染）、effort 档位、/compact 与上下文占用条 | after: as-foundation-review | kind: codex | keep-seat
  cid: fj-tui-modes-6627
- [ ] tui-observe: agent-tui 观测面板：折叠系统日志带（hooks/local_command 回显、api_retry、rate_limit、model_fallback）、子 agent 正文面板、Task list 面板 | after: as-foundation-review | kind: codex | keep-seat
  cid: fj-tui-observe-b90d
- [ ] tui-modes-review: 复核模式面板 | after: tui-modes | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-modes-review-9ee5
- [ ] tui-observe-review: 复核观测面板 | after: tui-observe | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-observe-review-8e89
- [ ] as-integrate2: 把 feat/as-foundation、feat/tui-sessions、feat/tui-input、feat/tui-modes、feat/tui-observe 合入 feat/agent-server，解冲突，typecheck 与全部 bun test 绿，真引擎实跑复验（Sonnet + gpt-6-astra 各 ≤4 turn：权限模式热切、hook 回显、图片、@ 补全） | after: as-foundation-review2,tui-sessions-polish,tui-input-review2,tui-modes-review2 | kind: codex
  cid: fj-as-integrate2-02a2
- [ ] dogfood-impl: 按方案实现 fj 坐席走 agent-tui：daemon launchd 常驻、fj task launch --runner agent-tui、契约首轮注入、审批策略、Herdr 忙闲、回滚开关；先 codex 坐席 | after: as-dogfood-design,as-integrate2b | kind: codex | keep-seat
  cid: fj-dogfood-impl-2bba
- [ ] dogfood-review: 复核 dogfood 实现：起一个真 codex 坐席跑一单玩具契约走完 launch→mail→settle | after: dogfood-impl | mode: readonly | kind: claude | keep-seat
  cid: fj-dogfood-review-1cdc
- [ ] trellis-step2: Trellis 迁移第二步（独立分支）：TRELLIS_AS=on 时 Trellis 新起会话跑在 AS thread 上（project 模式切流），会话绑定模型 pane/thread/legacy 归一，网页与手机端渲染权限模式、审批、系统日志；老链路不动可回滚 | after: dogfood-review | kind: codex | keep-seat
  cid: fj-trellis-step2-8442
- [ ] trellis-step2-review: 复核第二步：切流正确性、回滚、绑定归一、手机 E2E | after: trellis-step2 | mode: readonly | kind: claude | keep-seat
  cid: fj-trellis-step2-review-497e
- [ ] tui-sessions-fix: 返工会话管理复核：P0-1 命令在途击键串入下一条 prompt、P0-2 daemon 重启后无恢复入口、P1-1 选择器滚动、P2-1～P2-6 | after: tui-sessions-review | kind: codex | keep-seat
  cid: fj-tui-sessions-fix-514b
- [ ] tui-sessions-review2: 复核会话管理返工：用 review 的反例原样重打 P0/P1，抽查 P2 | after: tui-sessions-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-sessions-review2-ea09
- [ ] tui-input-fix: 返工输入形态复核：P0-1 bracketed paste 未归一 CR（多行塌成一行且发裸 \r）、P2-2 卡片自由回答区多行粘贴被丢、P2-3 fuzzyMatch 连续优先未实现 | after: tui-input-review | kind: codex | keep-seat
  cid: fj-tui-input-fix-97b0
- [ ] tui-input-review2: 复核输入形态返工：原样重打 P0-1，核 P2-2/P2-3 | after: tui-input-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-input-review2-3274
- [ ] tui-sessions-polish: 收尾会话管理二审剩余 P2-a～P2-f（/threads 后消息拼接、失败提示被覆盖、render 副作用、resume 失败残留订阅、/resume 关闭会话加确认、/threads 期间审批卡不可按） | after: tui-sessions-review2 | kind: codex | keep-seat
  cid: fj-tui-sessions-polish-8da0
- [ ] as-foundation-fix: 返工打底复核：P1-1 权限提升加授权门禁且 --allow-dangerously-skip-permissions 不再无条件常开、P1-2 未知顶层帧不杀会话、P2-1 effort 值域校验、P2-2 protocol.md 补表与类型块、P2-3 通知门禁口径、P2-4 set_model 落库、P2-5 小口径 | after: as-foundation-review | kind: codex | keep-seat
  cid: fj-as-foundation-fix-3383
- [ ] as-foundation-review2: 复核打底返工：原样重打 P1-1/P1-2，抽核 P2 | after: as-foundation-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-as-foundation-review2-f487
- [ ] tui-modes-fix: 返工模式面板复核：P1-1 readonly 一键解除且不可逆、P1-2 Shift+Tab 静默独占 5 分钟租约锁死他端、P1-3 bypassAvailable 取错基准、P1-4 dontAsk 绕过门禁；P2-1 租约错误码对齐打底、P2-2 /takeover 场景、P2-3 effort/model 跨端同步、P2-4 消息被顶掉、P2-5 s 键降级、P2-6 README | after: tui-modes-review | kind: codex | keep-seat
  cid: fj-tui-modes-fix-a27a
- [ ] tui-modes-review2: 复核模式面板返工：原样重打 P1-1～P1-4，抽核 P2 | after: tui-modes-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-modes-review2-6edd
- [ ] tui-observe-fix: 返工观测面板复核：P0-1 Ctrl-C 被自加租约门禁挡死、P1-1 换行冲破固定高度帧、P1-2 日志无界且全量重排致按键延迟、P1-3 租约生命周期（短租约/续期/UI 状态）、P2-1～P2-6 | after: tui-observe-review | kind: codex | keep-seat
  cid: fj-tui-observe-fix-798b
- [ ] tui-observe-review2: 复核观测面板返工：原样重打 P0/P1，抽核 P2 | after: tui-observe-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-observe-review2-1d2b
- [ ] tui-observe-fix2: 修观测面板二审新引入项：P1-1 审批回复竞态致卡片卡死 sending 30 秒且占租约、P2-1 释放租约失败把已送达报成失败、P2-2 环形缓冲与按事件偏移滚动叠加让在看条目滑走 | after: tui-observe-review2 | kind: codex | keep-seat
  cid: fj-tui-observe-fix2-3e7d
- [ ] tui-observe-review3: 复核观测面板 fix2：原样重打 P1-1 竞态与两条 P2 | after: tui-observe-fix2 | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-observe-review3-5594
- [ ] as-integrate2b: 把 feat/tui-observe 合入已集成的 feat/agent-server，解冲突，全量测试，真引擎实跑复验（Sonnet + gpt-6-astra 各 ≤4 turn：权限模式热切、hook 回显、图片、Ctrl-C 急停） | after: tui-observe-review3,as-integrate2 | kind: codex
  cid: fj-as-integrate2b-ff47
- [ ] dogfood-fix: 返工 dogfood 复核：P0-1 herdr pane run 成功无 JSON 被判失败致首次起位必败且 ready 握手被旁路、P1-1 herdr 不可用时关单泄漏 thread 与引擎、P2-1～P2-6（nudge 回滚只认 -32012、--socket 不传 token 路径、serviceTier 死参数、uninstall 非幂等、close 不关 pane 且门槛不一致、ready nonce 入 argv） | after: dogfood-review | kind: codex | keep-seat
  cid: fj-dogfood-fix-3342
- [ ] dogfood-review2: 复核 dogfood 返工并重跑真实试点（首次起位一次成功、herdr 不可用不泄漏、SIGKILL 恢复） | after: dogfood-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-dogfood-review2-495c
- [ ] dogfood-fix2: 切换前收尾：P1-2 握手未完成的单要有 CLI 出口可关（task close/abort 清干净不留噪音单）、P2-7 fj next 恢复命令补 --token-path 且 threadId 缺失不打 undefined、P2-8 paneSplit 失败信息不吐整段 JSON | after: dogfood-review2 | kind: codex | keep-seat
  cid: fj-dogfood-fix2-829a
- [ ] as-polish2: 集成后收尾（阶段 1 试点第 1 单，走 agent-tui runner）：模式面板 P2-2～P2-6、输入 P2-1 粘贴 y/s/n/a 不触发审批、AS 提权门禁与后端可用性判断顺序 | kind: codex
  cid: fj-as-polish2-b628
- [ ] dogfood-fix3: 阶段 1 首单实弹暴露：(a) fj task close 在 pane 已消失时报 pane_not_found 失败，应视为已关；(b) FJ_AGENT_TUI_BIN 未设且 agent-tui 不在 PATH 时 pane 秒退、ready 超时才报错，应预检并给清晰错误，并支持持久化配置默认路径；(c) pane 在 ready 前死亡时 phase 卡在 pane_started，应检测 pane 消失让本次尝试干净失败、重试从 prepared 重来 | after: dogfood-fix2 | kind: codex | keep-seat
  cid: fj-dogfood-fix3-866c
- [ ] as-pending-notify: 协议加只读的审批/请求状态通知（阶段 1 试点第 2 单，走 agent-tui runner）：thread/pendingRequests 通知在 serverRequest 创建、解析、超时时推给所有 attach 的客户端，含 requestId/itemId/kind/decidedBy；能力协商；client 库暴露；影子模式与 Trellis 可据此删掉 2 秒轮询 | kind: codex
  cid: fj-as-pending-notify-b2c5
- [ ] trellis-step2-fix: 返工第二步复核：P0-1 AS 会话重试抹掉原答案且必败、P1-1 非末端节点普通续聊 503、P1-2 TRELLIS_AS=off 对已绑定会话失效、P2-1 开关语义、P2-2 fallback 残留行与泄漏、P2-3 interrupt 依赖租约 | after: trellis-step2-review | kind: codex | keep-seat
  cid: fj-trellis-step2-fix-683f
- [ ] trellis-step2-review2: 复核第二步返工：用 review 的 probe.sh 原样重打 P0/P1，抽核 P2，真 Sonnet 复验一次 | after: trellis-step2-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-trellis-step2-review2-c4a2
- [ ] as-midfork: 协议支持任意 item 处分叉（阶段 1 试点第 3 单，走 agent-tui runner）：thread/fork 带 fromItemId 时从该点截断历史建新 thread（claude 用 --resume + --fork-session 与截断后的历史播种，codex 走 app-server 的 fork/回放能力或播种），保留原 thread 不变；能力标记；测试 | kind: codex
  cid: fj-as-midfork-4778
- [ ] as-notify-fork-review: 复核阶段 1 第 2/3 单：pendingRequests 只读通知与任意 item 分叉（协议兼容、播种保真、原生路径证据、真引擎复验） | after: as-pending-notify,as-midfork | mode: readonly | kind: claude | keep-seat
  cid: fj-as-notify-fork-review-3d29
- [ ] trellis-step2b: Trellis 第二步跟进（阶段 1 试点第 4 单，走 agent-tui runner）：重新 vendor 到含 pendingRequests 与任意 item 分叉的 agent-server；影子/project 路径删 2 秒轮询改订阅 pendingRequests；非末端续聊与显式 fork 在能力存在时走 thread/fork(fromItemId)，播种作回退；E2E 更新 | after: trellis-step2-review2 | kind: codex
  cid: fj-trellis-step2b-0bbe
- [ ] as-polish3: 阶段 1 试点第 5 单（agent-tui runner）：修 notify/fork 复核 P2×4——turnCompleted 抹掉播种标记的守卫、copyPrefix 不复制 fork_points 致分叉的分叉降级、运行中 fork 冻成永久 inProgress 孤儿、未协商客户端被快照灌入 pendingRequestStates | after: as-notify-fork-review | kind: codex
  cid: fj-as-polish3-b73c
- [ ] trellis-step2b-review: 复核第二步跟进：vendor 同步、删轮询后 SSE 流量、midfork 路径与回退、E2E；真 Sonnet 一次 | after: trellis-step2b | mode: readonly | kind: claude | keep-seat
  cid: fj-trellis-step2b-review-2116
- [ ] tui-fork-notify-ui: agent-tui 接新协议（阶段 1 试点第 6 单，agent-tui runner）：审批卡显示「已由 X 处理」与待处理计数（pendingRequests）；/fork 支持选任意 item 分叉（midThreadFork，缺能力时明确提示）；/threads 显示 forkedFrom；PTY E2E | kind: codex
  cid: fj-tui-fork-notify-ui-bc2c
- [ ] trellis-step2c: 第二步跟进返工（阶段 1 试点第 7 单，agent-tui runner）：vendor 同步到 sm-toolkit feat/agent-server 当前 HEAD（含分叉边界/播种/P2 修复），重跑单测与两套手机验收 | after: trellis-step2b-review | kind: codex
  cid: fj-trellis-step2c-31e1
- [ ] tui-fn-review: 复核 agent-tui 新协议接入：他端处理撤卡、待处理计数、/fork 选择器与直达、无能力降级、/threads 来源、重连快照 | after: tui-fork-notify-ui | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-fn-review-57e0
- [ ] tui-engine-cmds: agent-tui 引擎命令面（阶段 1 试点第 8 单，agent-tui runner）：! shell 模式（bash 输入类型）、/diff /context /usage /mcp /rewind 经 engineControl 直通并渲染，不支持的后端优雅提示；PTY E2E | kind: codex | keep-seat
  cid: fj-tui-engine-cmds-f7cb
- [ ] tui-fn-fix: 返工 TUI 新协议接入复核（阶段 1 试点第 9 单，agent-tui runner）：P1-1 审批/问题卡占屏时 Enter 盲发 thread/fork 并切走会话；P2-1 无本端卡片的请求计数与终态顶状态行、P2-2 离线角标与计数脱钩、P2-3 摘要按列宽截断、P2-4 仅新通知 daemon 下 pendingStates 不回收终态 | after: tui-fn-review | kind: codex
  cid: fj-tui-fn-fix-957c
- [ ] tui-fn-review2: 复核 TUI 新协议接入返工：原样重打 P1-1，抽核 P2 | after: tui-fn-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-fn-review2-0b70
- [ ] tui-cmds-review: 复核 TUI 引擎命令面：! shell 模式与中断、/diff /context /usage /mcp /rewind 直通渲染、不支持后端提示、/rewind 确认、mock 改动只服务测试 | after: tui-engine-cmds | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-cmds-review-d60e
- [ ] trellis-step2c-review: 复核第二步跟进返工：vendor 新鲜度（≥9221fa6 且为上游 HEAD 祖先）、影子 E2E 高度收缩误判修复、两套手机验收独占复跑 | after: trellis-step2c | mode: readonly | kind: claude | keep-seat
  cid: fj-trellis-step2c-review-65a0
- [ ] tui-modal-router: 阶段 1 试点第 10 单（agent-tui runner）：合入 feat/tui-engine-cmds 后统一 TUI 的模态按键路由（审批卡 > 确认提示 > 选择器 > 输入框，全局快捷键不被吞，缓冲区按模式隔离），修 tui-fn-review2 的 P1-1/P1-2/P2-1 与 tui-cmds-review 的 P1-1/P2-1～P2-5 | after: tui-fn-review2,tui-cmds-review | kind: codex
  cid: fj-tui-modal-router-d1a0
- [ ] tui-router-review: 终审 TUI 模态路由与命令面合并：两份报告反例原样重打，穿透矩阵抽核，全局快捷键清单，合并后零回归 | after: tui-modal-router | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-router-review-5d6c
- [ ] as-doc-audit: 阶段 2 试点第 1 单（Claude sonnet 走 agent-tui runner，只读）：审计 docs/agent-server/{README,protocol,trellis-migration}.md 与实现的一致性，列缺口与过期陈述 | kind: claude
  cid: fj-as-doc-audit-5dfd
- [ ] as-claude-bypass-fix: 阶段 2 P0：daemon 起 claude 一律注入 --permission-prompt-tool stdio 与 --settings permissions.ask=[*]，bypassPermissions 线程仍每条工具弹审批，无人值守 Claude 坐席必卡；按权限模式正确映射 argv 与审批策略，补 argv 单测与真 Sonnet 冒烟 | kind: codex
  cid: fj-as-claude-bypass-fix-a9c1
- [ ] as-integrate3: 把 feat/dogfood（fjContext 受限协议、agent-tui ready/参数、launchd 模板）合入 feat/agent-server，解冲突，全量测试，构建 dist，让试点 daemon 与 agent-tui 能从 feat/agent-server 起（含权限映射修复） | after: as-claude-bypass-fix | kind: codex
  cid: fj-as-integrate3-7bde
- [ ] as-doc-fix: 阶段 2 试点第 2 单（Claude sonnet 走 agent-tui runner，可写）：按审计修 protocol.md 字段缺漏、README 路线图与已知风险、trellis-migration 环境变量名/分叉边界/验收记录、agent-tui README 命令表 | after: as-doc-audit | kind: claude
  cid: fj-as-doc-fix-89f6
- [ ] as-readonly-allow: 阶段 2 试点第 3 单（Claude sonnet 走 agent-tui runner，可写）：审批经纪人加只读命令免审名单（READONLY_AUTO_ALLOW 下沉 daemon）——readonly/plan/default 线程下 ls/cat/find/grep/git log 等只读命令自动放行并留痕，写命令照常审批；配置可覆盖；单测 + 真 Sonnet 冒烟 | after: as-doc-fix | kind: claude
  cid: fj-as-readonly-allow-76d8
- [ ] as-readonly-allow-review: 复核只读命令免审名单：名单绕过对抗（管道/子 shell/反引号/find -exec/git 写子命令/env 前缀/别名）、留痕、配置覆盖；真引擎复验须显式 sonnet；核交付冒烟误用 fable 的事实 | after: as-readonly-allow | mode: readonly | kind: claude | keep-seat
  cid: fj-as-readonly-allow-review-332b
- [ ] as-model-guard: daemon 模型守卫（阶段 1 式 codex 单）：thread/start 与 resume 建线程必须显式 model，缺省不得落到环境默认；模型命中拒绝名单（默认 fable）直接拒绝并留痕；名单可配置；单测 + 文档 | after: as-readonly-allow | kind: codex
  cid: fj-as-model-guard-6241
- [ ] as-readonly-allow-review2: 复核只读名单返工：原样重打 P0/P1 绕过，抽核 P2，抽查审计持久化 | after: as-readonly-allow-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-as-readonly-allow-review2-5f0a
- [ ] as-readonly-allow-fix: 阶段 2 试点第 4 单（Claude sonnet 走 agent-tui runner，可写）：修只读名单复核 P0×3（换行与单 & 不是分隔符、git log/diff/show 的 --output 写文件）、P1×3（git branch 写形式、find -fls、免审放行无持久化审计）、P2×4（basename 冒用、file -C -m、文档口径、测试覆盖） | after: as-readonly-allow-review | kind: claude
  cid: fj-as-readonly-allow-fix-a0a0
- [ ] as-readonly-allow-fix2: 阶段 2 试点第 5 单（Claude sonnet 走 agent-tui runner，可写）：只读名单改为 fail-closed 的白名单解析器（只放行可完整解析、无替换/引号内 $/重定向/包装命令的简单命令链），修 P0-A 双引号命令替换、P0-B env -S、P1-A rg --pre、P2 git 全局 flag 与注释 | after: as-readonly-allow-review2 | kind: claude
  cid: fj-as-readonly-allow-fix2-f53a
- [ ] as-readonly-allow-review3: 复核只读名单 fail-closed 解析器：全部历史向量 + 新造向量，真机一次 | after: as-readonly-allow-fix2 | mode: readonly | kind: claude | keep-seat
  cid: fj-as-readonly-allow-review3-8b89
- [ ] skill-docs-sync: 阶段 2 试点第 6 单（Claude sonnet 走 agent-tui runner，可写）：herdr-leader 技能文档双向同步——焚决 skill/ 的 agent-tui runner 文档（--runner 调用面、runners 说明、policy agent_tui_bin、恢复与中止指令）整理成安装副本可用形态并产出 install.patch；安装副本里 leader 手工追加的实弹条目回灌 焚决 seats.md；不动 fj.js | keep-seat
  cid: fj-skill-docs-sync-4bc1
- [ ] mobile-wave3-nits: 阶段 2 试点第 7 单（Claude sonnet 走 agent-tui runner，可写）：三波 review-c2 遗留——C2-1 收藏超过 50 条时第 51 条起不可达（加载更多或 cursor 分页）、C2-2 别处取消的收藏本地不清、C2-3 滚到底恢复 chrome 的 scrollTop 补偿被 clamp 残留位移、H-3 useScrollHide 模块级单例；七条手机脚本整套重跑 | kind: claude
  cid: fj-mobile-wave3-nits-d2bb
- [ ] mobile-wave1-nits: 阶段 2 试点第 8 单（Claude sonnet 走 agent-tui runner，可写）：一波 review 遗留——N-1 删 8 处已被全局兜底覆盖的 max-md:text-[16px] 死代码、N-2 字号扫描器盲区（style 变量传入、globals.css 末尾追加规则）加廉价断言、N-3 手机 /settings/prefs 在 select 变 16px 后的布局截图确认 | after: mobile-wave3-nits | kind: claude
  cid: fj-mobile-wave1-nits-a015
- [ ] cc-tui-design: 解构本地 Claude Code 源码（~/python/ai/claude-code）的 TUI 核心设计：渲染栈 fork、消息模型、输入与按键、模态焦点、模式与状态栏、命令面、多 agent 呈现、UI 与内核分离形态；提炼原则与取舍表 | mode: readonly | kind: claude
  cid: fj-cc-tui-design-c117
- [ ] tui-self-audit: 审计我们 agent-tui 的现状：架构与技术栈、交互清单与成熟度、结构性弱点、与协议的耦合面、重构时可保留与应替换的模块 | mode: readonly | kind: codex
  cid: fj-tui-self-audit-66e5
- [ ] tui-adoption-plan: 以 Claude Code 核心设计为参照改造 agent-tui 的方案（保留 AS 协议内核）：目标架构、分阶段可独立验收的拆解、每单交付物与验收命令、是否引入上游 Ink 的取舍、风险与回退；progress 风格 spec 供用户拍板 | after: cc-tui-design,tui-self-audit2,oss-tui-eval | mode: readonly | kind: claude
  cid: fj-tui-adoption-plan-7755
- [ ] tui-self-audit2: 审计我们 agent-tui 的现状：架构与技术栈、交互清单与成熟度、结构性弱点、与协议的耦合面、重构时可保留与应替换的模块（重开：codex 只读权限无法落盘） | mode: readonly | kind: codex
  cid: fj-tui-self-audit2-41fc
- [ ] oss-tui-eval: 评估复用开源 TUI 代码替代自研渲染层：OpenTUI / opencode TUI 客户端 / pi / gemini-cli / Ink 的许可证、渲染模型、同机基准（10000 行 CJK 历史 + 2000 帧流式）、与我们协议的耦合面与工作量；给推荐路线 | mode: readonly | kind: codex
  cid: fj-oss-tui-eval-f8c0
- [ ] as-readonly-gate-fix: 阶段 2 试点第 10 单（Claude sonnet 走 agent-tui runner，可写）：修三审 P0-1——readonly 线程走 CLI plan 模式时 Bash 不回传 can_use_tool，免审名单与经纪人被整体绕过；改为 daemon 强制 fail-closed（default 模式 + ask 全部 + disallowedTools + 经纪人拒写），plan 与 readonly 拆开；顺手修 P2-1/3/4/5 | kind: claude
  cid: fj-as-readonly-gate-fix-bcd4
- [ ] as-readonly-gate-review: 复核只读门修复：原样重打三审 Run 1–3，真机 readonly/plan/default 三线程各一次（显式 sonnet），抽核 P2 | after: as-readonly-gate-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-as-readonly-gate-review-36dd
- [ ] as-readonly-gate-fix2: 阶段 2（Claude sonnet 走 agent-tui runner，可写）：修四审 P0-1 独立 bash turn 的门与 readonly_auto_allow 开关解耦、P0-2 default/acceptEdits 独立 bash turn 过经纪人、P1-1 readonly 拒写审计行真机可达；五模式参数化测试 + 真机冒烟 + 文档 | after: as-readonly-gate-review | kind: claude
  cid: fj-as-readonly-gate-fix2-25bd
- [ ] as-readonly-gate-review2: 复核只读门二次返工：原样重打四审 T1–T3 与五模式独立 bash turn，真机显式 sonnet | after: as-readonly-gate-fix2 | mode: readonly | kind: claude | keep-seat
  cid: fj-as-readonly-gate-review2-ea71
- [ ] as-readonly-gate-fix3: 阶段 2（Claude sonnet 走 agent-tui runner，可写）：修五审 P1-1 只读线程写工具禁用事实持久化到 approvals 并可在 attach 后查到；顺手 P2-1 bypass/dontAsk 自动放行落审计行、P2-2 文档过期句 | after: as-readonly-gate-review2 | kind: claude
  cid: fj-as-readonly-gate-fix3-5a3a
- [ ] as-readonly-gate-review3: 复核只读门三次返工：attach 后可查到 readonly_tools_disabled 与 auto_response 审计行，真机显式 sonnet，全量测试绿 | after: as-readonly-gate-fix3 | mode: readonly | kind: claude | keep-seat
  cid: fj-as-readonly-gate-review3-1d4d
- [ ] tui-p0-compliance: 阶段 0 合规闸与依赖锁：check-cc-taboo.sh 进 CI、锁 @opentui/core+react 0.5.11 与 React 19.2.4、确认 keymap 包名版本、third_party/opentui 许可文件、tsconfig jsx | kind: claude
  cid: fj-tui-p0-compliance-e701
- [ ] tui-p1a-baseline: 阶段 1a 基线 + 帧探针：收编基准夹具为 apps/agent-tui/bench（三条负载、2000 样本口径）、现有 renderer 分段计时 AGENT_TUI_FRAME_LOG、复现基线量级 | kind: codex
  cid: fj-tui-p1a-baseline-0f7b
- [-] tui-p1b-gate-terminal: 阶段 1b 闸①真实输入与终端矩阵：最小 OpenTUI spike 在 Herdr/tmux、Terminal、iTerm2、Ghostty 验中文 IME 预编辑与候选框跟随、多行中文+ZWJ、Shift-Enter、bracketed paste、选区复制、resize、外部编辑器往返；人工验收留录屏 | after: tui-p0-compliance,tui-p1a-baseline | kind: claude
- [-] tui-p1c-gate-history: 阶段 1c 闸②真实变高历史：一万条真实混合 Item 在 OpenTUI spike 上流式/折叠/回看/搜索/resize，p95 ≤ 基线 1/3 且锚点不漂，采集 React commit 段占比 | after: tui-p0-compliance,tui-p1a-baseline | kind: codex
- [-] tui-p1d-gate-release: 阶段 1d 闸③发布与背压：bun build --compile 含 worker/动态资源、隐藏 node_modules 仍可跑、慢 PTY 下写线程队列与 RSS、SIGINT/SIGTERM/EPIPE、崩溃后终端恢复 | after: tui-p0-compliance,tui-p1a-baseline | kind: claude
- [ ] cc-native-tui-spike: 可行性 spike：Claude Code 原生 TUI（公开二进制）经其 direct-connect / remote 协议接 agent-server 作显示端——公开构建是否可达、协议形状与 AS 映射、mktemp 假服务端让 claude 连上并回传一次权限请求、估工与风险 | mode: readonly | kind: claude
  cid: fj-cc-native-tui-spike-0e0a
- [ ] tui-display-quickwin: agent-tui 信息设计急救（现有渲染器上）：工具调用一行摘要 + 输出默认折叠 Ctrl-O 展开、空 reasoning 不渲染、状态头去占位符压两行、角色分色与 turn 分隔、按词折行、底部提示一行；不动协议/租约/审批语义 | kind: claude
  cid: fj-tui-display-quickwin-e873
- [ ] tui-display-quickwin-review: 异源复核信息设计急救：174 测试与快照变更逐条核、折叠/展开/收起真机三连、状态头无占位符、按键语义零回归 | after: tui-display-quickwin | mode: readonly | kind: codex
  cid: fj-tui-display-quickwin-review-9ab4
- [ ] codex-native-tui-spike: 可行性 spike：Codex 官方 TUI（Apache-2.0）作显示端接 agent-server——TUI 是否走 app-server 协议或可连外部 server、AS 对外暴露 app-server 协议的方法清单与映射、三条最小改动路径估工 | mode: readonly | kind: codex
  cid: fj-codex-native-tui-spike-23ce
- [ ] tui-ingress-design: 方案：AS 暴露 Codex app-server 协议 ingress 作为单一 TUI 入口——入口形态、进程模型、Claude 线程的 item 合成与命令降级、治理插入点、四个切片（Codex 端到端 / Claude 显示 / 多线程与恢复 / 硬化与升级回归）、agent-tui 退役路径 | mode: readonly | kind: claude
  cid: fj-tui-ingress-design-cd8e
- [ ] tui-ingress-slice1: codex-ingress slice 1：Codex 线程端到端——ws listener + 握手 + 每连接 AS client、control 进程与 A 桶转发、thread↔进程路由、start/turn/interrupt/resume 映射、native 通知回流、审批经 broker 收口、codex_ingress.enabled 开关、PTY 驱动真实 codex --remote 的冒烟脚本 | kind: codex
  cid: fj-tui-ingress-slice1-9065
- [ ] tui-ingress-slice1-review: 复核 slice 1：官方 codex --remote 真机走 start/turn/审批/resume/interrupt，开关关闭逐字节等价，路由与 ID 规则反例，帧上限与 token 机制，风险表 #7 动态工具 | after: tui-ingress-slice1 | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-ingress-slice1-review-f08c
- [ ] tui-display-quickwin-fix: 修急救复核 P1×6（失败命令折叠态显示退出码、Read/Grep 单行摘要、空 reasoning 不留空项、折叠态 ≤ 8 物理行、默认环境测试全绿等） | after: tui-display-quickwin-review | kind: claude
  cid: fj-tui-display-quickwin-fix-d55f
- [ ] tui-display-quickwin-review2: 异源复核急救返工：原样重打 P1-1～P1-6，真机折叠/展开/收起，默认环境 bun test | after: tui-display-quickwin-fix | mode: readonly | kind: codex
  cid: fj-tui-display-quickwin-review2-6bee
- [ ] tui-display-quickwin-fix2: 修急救二审 P1-5：折叠预算按最终显示行 ≤ 8，任意列宽与超长行成立，keep=0 路径有单测覆盖，真机长行截帧 | after: tui-display-quickwin-review2 | kind: claude
  cid: fj-tui-display-quickwin-fix2-7aac
- [ ] tui-display-quickwin-review3: 异源终审急救：原样重打 P1-5 长行矩阵与真机，其余 P1 抽核不回归 | after: tui-display-quickwin-fix2 | mode: readonly | kind: codex
  cid: fj-tui-display-quickwin-review3-3a78
- [ ] tui-ingress-slice2: codex-ingress slice 2：Claude 线程在 Codex TUI 里显示与交互——model/list 注入 Claude 模型、thread/start 选后端、AS Item → native item 单向合成（agentMessage/reasoning/commandExecution/fileChange/toolCall/mcpToolCall/subAgent/webSearch/plan/error）、四类审批 1:1、不支持方法明确错误、PTY 冒烟 --backend claude | after: tui-ingress-slice1-review2 | kind: codex
  cid: fj-tui-ingress-slice2-6772
- [ ] tui-ingress-slice2-review: 复核 slice 2：官方 TUI 驱动真实 Sonnet 线程（显式 model）start/turn/审批/resume/interrupt，合成 item 与 as/1 视图一致，不支持方法错误码，Codex 线程零回归 | after: tui-ingress-slice2 | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-ingress-slice2-review-39e3
- [ ] tui-ingress-slice1-fix: 修 slice 1 复核 P1：零 turn 线程 resume 报 list_turns 不支持——实现 thread/turns/list 与 resume 历史分页按上游语义，冒烟加 resume_fresh_ok（as/1 建线程 → TUI resume → 发一轮），5 次全过 | after: tui-ingress-slice1-review | kind: codex
  cid: fj-tui-ingress-slice1-fix-cf4c
- [ ] tui-ingress-slice1-review2: 复核 slice 1 返工：resume_fresh_ok 真机、41 项反例不回归、turns/list 分页与上游一致 | after: tui-ingress-slice1-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-tui-ingress-slice1-review2-d094
- [ ] tui-ingress-slice2-fix: slice 2 返工：Claude 通用工具审批投影为 native tool/requestUserInput（allow/deny）并映射回 broker；live effort 明确错误文案；multiSelect 投影为自由作答加提示；并修 slice2-review 列出的 P0/P1 | after: tui-ingress-slice2-review | kind: codex
  cid: fj-tui-ingress-slice2-fix-d5b8
- [ ] tui-ingress-slice2-review2: 复核 slice 2 返工：干净 checkout 下两种后端冒烟、claude_threads 开关、通用工具审批的 requestUserInput 投影真机 allow/deny、effort 与 multiSelect 投影、P2 处理、Codex 零回归 | after: tui-ingress-slice2-fix | mode: readonly | kind: claude
  cid: fj-tui-ingress-slice2-review2-d860
- [ ] tui-ingress-slice3: codex-ingress slice 3：多线程 / fork / 历史分页 / 断线恢复——thread/list 聚合与 loaded/list、thread/fork 映射、turns/items 分页游标与上游一致、连接断开后重连接管 pending 与订阅、detach ≠ close；PTY 冒烟加 multi_thread_ok / fork_ok / reconnect_ok | kind: codex
  cid: fj-tui-ingress-slice3-d89c
- [ ] tui-ingress-slice3-review: 复核 slice 3：两线程交替不串线、fork 边界、分页与上游逐字段、断线重连后 pending 重放与租约、Codex/Claude 零回归 | after: tui-ingress-slice3 | mode: readonly | kind: claude
  cid: fj-tui-ingress-slice3-review-52eb
- [ ] tui-ingress-slice4: codex-ingress slice 4：治理硬化与升级回归——unix:// WebSocket 端点、副作用方法白名单与 readonly deny 表全覆盖、引擎死亡后 activeTurn 清理与 close 可用（backlog agent-server-busy-after-engine-death）、显示端断开不中断 turn（backlog agent-tui-detach-interrupts-turn）、钉 TUI 0.153.4 + 协议 schema 的升级回归脚本 | after: tui-ingress-slice3-review | kind: codex
  cid: fj-tui-ingress-slice4-8704
- [ ] tui-ingress-slice4-review: 复核 slice 4：unix:// 真机、白名单 fail-closed 反例、引擎死亡与显示端断开两条回归、升级回归脚本可跑 | after: tui-ingress-slice4 | mode: readonly | kind: claude
  cid: fj-tui-ingress-slice4-review-b917
- [ ] fj-runner-codex-tui: 焚决 fj：--runner codex-tui（坐席显示端改 codex --remote，fjContext / ready 改由 fj 自己建线程、删 ready-file 协议、Herdr 状态旁挂 reporter），阶段 1 式试点 3 单后切默认；agent-tui 退役路径 | kind: codex
  cid: fj-fj-runner-codex-tui-383b
- [ ] fj-runner-codex-tui-review: 复核 fj codex-tui runner：真机起位（Claude/Codex）、注入、进度、关闭、Herdr 四态旁挂、无 ready-file、配置与文档、反例（未开 ingress / 错 token / 外部关线程 / --force 重派） | after: fj-runner-codex-tui | mode: readonly | kind: claude
  cid: fj-fj-runner-codex-tui-review-19dc
- [ ] tui-ingress-lease-fix: 修 ingress 租约语义：resume/attach 不取租约，只在升权时取短租约并释放；close/interrupt 不受他人输入租约门控；冒烟加 external_client_reply_while_attached_ok | kind: codex
  cid: fj-tui-ingress-lease-fix-400a
- [ ] tui-ingress-slice3-fix: 修 slice 3 复核 P1：先合 feat/codex-ingress，冒烟加 list_contains_both_backends（同一连接一 Codex 一 Claude 交替发 turn、list 含两者、picker 切换），两后端各 3 次 | after: tui-ingress-slice3-review | kind: codex
  cid: fj-tui-ingress-slice3-fix-65a8
- [ ] tui-ingress-slice3-review2: 复核 slice 3 返工：跨后端双线程真机、合并后零回归 | after: tui-ingress-slice3-fix | mode: readonly | kind: claude
  cid: fj-tui-ingress-slice3-review2-f820
- [ ] as-readonly-p2-whitelist: codex-tui runner 试点第 1 单（Codex）：只读名单 P2-5——find/rg/grep/file 改选项白名单，三轮历史向量全回归 | kind: codex
  cid: fj-as-readonly-p2-whitelist-5c83
- [ ] ingress-docs: codex-tui runner 试点第 2 单（Claude sonnet）：codex-ingress 文档收口——protocol 章节校对、README 路线图、人类使用 quickstart | kind: claude
  cid: fj-ingress-docs-b8ce
- [ ] as-readonly-p2-whitelist-review: 复核只读名单白名单化：三轮历史向量重打、find/rg/grep/file 新造反例、fail-closed、真机 | after: as-readonly-p2-whitelist | mode: readonly | kind: claude
  cid: fj-as-readonly-p2-whitelist-review-d2fb
- [ ] as-readonly-p2-whitelist-fix: 修四审 P0-1：展开闸解析器级全局化（brace/glob/tilde/替换元字符任一 argv 即 deny），三轮向量 + 四审向量固化；P2-1～4 处理 | after: as-readonly-p2-whitelist-review | kind: codex
  cid: fj-as-readonly-p2-whitelist-fix-4742
- [ ] as-readonly-p2-whitelist-review2: 五审只读名单：展开闸全局化反例（所有免审命令 × 展开元字符 × 引号形态）、真机 git brace 向量、P2 处理、零回归 | after: as-readonly-p2-whitelist-fix | mode: readonly | kind: claude
  cid: fj-as-readonly-p2-whitelist-review2-9f49
- [ ] tui-ingress-slice3-fix2: 修 slice 3 再审 P1-1：TUI 级模型对已存在线程的跨后端 override 改为沿用线程模型并可见提示（不失败、不静默切引擎）；补 requestUserInput 的 isBlocking 等 schema 必填并把 wire 逐条 schema 校验做成冒烟判据 | after: tui-ingress-slice3-review2 | kind: codex
  cid: fj-tui-ingress-slice3-fix2-5f7f
- [ ] tui-ingress-slice3-review3: 复核 slice 3 二次返工：Claude 主会话（--model sonnet）真机切换后端线程可用、wire_schema_clean、零回归 | after: tui-ingress-slice3-fix2 | mode: readonly | kind: claude
  cid: fj-tui-ingress-slice3-review3-93dc
- [ ] tui-ingress-integrate: 集成：把 feat/codex-ingress-s3（含二次返工）、feat/codex-ingress-s4、feat/readonly-p2-whitelist 合入 feat/codex-ingress，解冲突，全量测试与 typecheck，两后端全部判据冒烟各 3 次（含 unix://、wire_schema_clean、cross_backend_model_override_tolerated），文档合并；交付后由 leader 重建试点 daemon | after: tui-ingress-slice3-review3,tui-ingress-slice4-review,as-readonly-p2-whitelist-review2 | kind: codex
  cid: fj-tui-ingress-integrate-a848
- [ ] fenjue-ship-main: 焚决 feat/agent-tui-runner 本地合入 main，测试绿，bundle sha 与安装副本一致 | kind: codex
  cid: fj-fenjue-ship-main-ea23
- [ ] trellis-integrate-d: Trellis 四波集成 feat/ship-d：桥 → 影子 → 第二步 → mobile wave3 → wave1，tsc/test，七条手机脚本 + AS E2E 在隔离实例跑绿，不 vendor 不部署 | kind: codex
  cid: fj-trellis-integrate-d-2925
- [ ] smtk-ship-main: sm-toolkit：feat/codex-ingress → main（gh PR + merge），~/sm-toolkit 拉 main 构建 dist，按 scripts/agent-server 模板装 launchd（含 codex_ingress 配置），停 pane daemon 改由 launchd 常驻，两后端冒烟对常驻 daemon 各 3 次 | after: tui-ingress-integrate | kind: codex
  cid: fj-smtk-ship-main-3d07
- [ ] trellis-ship-d: Trellis 上线：feat/ship-d 重新 vendor ~/sm-toolkit main 的 agent-server，tsc/test/E2E，gh PR → merge → make deploy → 验活；再给一个项目开 TRELLIS_AS（写明回退开关） | after: trellis-integrate-d,smtk-ship-main | kind: codex
  cid: fj-trellis-ship-d-6529
- [ ] ingress-fresh-start: 修生产冒烟 P1：官方 TUI 冷启动 thread/start 的 native config override 被整体拒绝——按项分流映射/忽略/拒绝，冒烟加 fresh_tui_session_ok 与 --mode prod，PR 合 main 并构建，重启由 leader | kind: codex
  cid: fj-ingress-fresh-start-01bb
- [ ] as-adopt: 外部线程收编主页：daemon 上非 Trellis 开的线程自动成为主页会话（归属按 cwd、线性树回填、来源标记），双向可提问/审批/中断，TRELLIS_AS_ADOPT 开关，E2E 脚本 + 真机证据，不 push 不部署 | kind: codex | keep-seat
  cid: fj-as-adopt-a06a
- [ ] as-adopt-review: 异源复核收编：真机对常驻 daemon 建临时线程验证出现/归属/提问/审批/删除解绑/开关 off，E2E 与单测反例，零回归 | after: as-adopt | mode: readonly | kind: claude | keep-seat
  cid: fj-as-adopt-review-d57c
- [ ] as-adopt-ship: 收编上线：feat/as-adopt → PR 合 main → make deploy → 生产 TRELLIS_AS_ADOPT=on → 临时线程真机验活（写明回退） | after: as-adopt-review2 | kind: codex
  cid: fj-as-adopt-ship-184a
- [ ] as-observe-retire: 删掉只读观察页：/console/threads、/api/as/threads*、ThreadLogView、as-shadow 脚本与文档引用，PR 合 main 并部署 | after: as-adopt-ship | kind: codex
  cid: fj-as-observe-retire-6552
- [ ] codex-mapper-display-items: agent-server Codex 映射补齐 0.153.4 全部 ThreadItem 类型（sleep/imageView/hookPrompt/enteredReviewMode/exitedReviewMode → toolCall），schema 全覆盖测试，真机 pty 证明不再出 Unknown 红条 | kind: codex
  cid: fj-codex-mapper-display-items-aa07
- [ ] ui-audit: Trellis 交互/UI 整体体检（只读）：13 条路由桌面+手机截图清单、核心动线走查、P0–P2 问题清单、一致性统计、保留项、5–8 个重设计方向候选供用户拍板 | mode: readonly | kind: claude
  cid: fj-ui-audit-7b23
- [ ] ui-nits-p1: UI 体检第一批单点修复：侧栏 Herdr 裸异常改降级文案（P1-8）、machine 页 GB/TB 单位（P1-10）、新会话默认模型文案与 Header 一致（P2-1），带测试与修后截图，不 push 不部署 | after: ui-audit | kind: codex
  cid: fj-ui-nits-p1-f2de
- [ ] sidebar-tree-ia: 侧栏与工作树信息架构方案（只读）：现状盘点每种条目实体来源与不一致点、统一概念模型、A/B/C 候选 + 推荐 + 分波顺序、自包含 HTML 静态稿供用户拍板 | after: ui-audit | mode: readonly | kind: claude
  cid: fj-sidebar-tree-ia-4784
- [ ] sidebar-wave1: 侧栏 IA 波 1 · 统一最小单元：会话种类谓词放开（herdr/task 进列表 + 来源 chip），删稍后再读/定时任务/未归组三组与两处死代码，前后截图与 SQL 对比，11 条手机脚本绿 | after: sidebar-tree-ia | kind: codex
  cid: fj-sidebar-wave1-cc46
- [ ] sidebar-wave2: 侧栏 IA 波 2 · 排布切换：工具条「按项目/按时间」+ 来源筛选 + 含归档；最近组与 Herdr 组退役（能力搬入会话内面板/行内状态）；chat 会话归伪项目「速记」；空工作区折叠 | after: sidebar-wave1 | kind: codex
  cid: fj-sidebar-wave2-c6c6
- [ ] sidebar-wave3: 侧栏 IA 波 3 · 会话内面板合并：TreePanel + Outline → 右侧 push 式「结构」面板（默认 36px 竖条），递归森林 + 当前话题 + 当前链高亮 + 其它分支，手机复用全屏 sheet，正文零遮挡 | after: sidebar-wave2-integrate | kind: codex
  cid: fj-sidebar-wave3-8dc6
- [ ] sidebar-wave4: 侧栏 IA 波 4 · 画布地图化：画布改为面板里的地图覆盖层，进入必 fitView，选中即关闭落回线性 | after: sidebar-wave3 | kind: codex
  cid: fj-sidebar-wave4-7058
- [ ] as-adopt-fix: 收编返工：修复核 P1-1（cwd 等于系统根被收进主目录/暂存区）与 P1-2（每 1.5 秒全量快照 30 MB → 增量 cursor + 仅变化线程 attach），顺手 P2-1～3，探针修前后数字 | after: as-adopt-review | kind: codex | keep-seat
  cid: fj-as-adopt-fix-4fb3
- [ ] as-adopt-review2: 复核收编返工：ownership-exact 全 PASS、探针稳态零 attach、P2 处理、零回归 | after: as-adopt-fix | mode: readonly | kind: claude | keep-seat
  cid: fj-as-adopt-review2-ebce
- [ ] sidebar-wave2-integrate: 波 2 集成：feat/sidebar-wave2 合入 origin/main（含收编 PR #48/#49），解冲突保住两边语义，tsc/test/11 条脚本绿，push；PR #50 由主控合并部署 | after: sidebar-wave2 | kind: codex
  cid: fj-sidebar-wave2-integrate-b80f
- [ ] as-controls-polish: 收编会话节点视图：引擎事件默认过滤+人话化+可展开原始 JSON，外部会话权限只读，截图验证 | after: as-adopt-ship | kind: codex
  cid: fj-as-controls-polish-dfcc
- [ ] canvas-map-layout: 返工地图布局：话题块内真树层级布局、边不交叉不穿卡、小会话放大到可读、与旧画布同会话对照截图 | after: sidebar-wave4 | kind: codex
  cid: fj-canvas-map-layout-3a3c
- [ ] structure-floating-panel: 结构面板改回小浮窗+小点形态（用户裁决）：右下角浮动小窗、行首状态圆点、内容模型不变、正文列宽恢复、Composer 不被遮，对照旧截图 | after: canvas-map-layout | kind: codex
  cid: fj-structure-floating-panel-7b4f
- [ ] restore-tree-panel: 树面板原样恢复到波 3 之前（013adb9 的 TreePanel/Outline 逐字恢复），删新结构面板，地图挂回旧画布按钮，逐项 DOM 对照旧截图 | after: structure-floating-panel | kind: codex
  cid: fj-restore-tree-panel-ccd2
- [ ] pending-bar: 待办层：Header 下跨会话「等你处理」横条（跳转/就地允许拒绝/撤卡），审批卡按钮主次分明，手机复用等待横幅，不新增轮询 | after: ui-audit | kind: codex
  cid: fj-pending-bar-5cfe
