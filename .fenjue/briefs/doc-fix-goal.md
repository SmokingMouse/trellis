按独立审阅改稿。你上一单的成稿与配套文件在 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-doc-write-d187/out（article.md、overview.svg、plan.md、verify.md、sources.md）；审阅报告 /Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-doc-review-66bc/out/review.md（结论：需改稿，P0 六条、P1 十条、P2 七条，附抽核清单与可复跑命令）；Brief 不变：/Users/smokingmouse/python/learning/trellis/.fenjue/briefs/arch-doc-brief.md。
要求：
(1) P0 与 P1 全部修；P2 逐条判断，不修的写明理由。事实类修正必须回源码/报告核实后再写，审阅给的复核命令可直接复跑；影子模式状态按审阅报告给的当前真相改（返工完成、二轮复核通过、卫生项已清、依赖 vendor 内置、观察者默认关）。
(2) 引用规则：优先引用 git 里存在的路径（各分支已提交的 progress/sessions 条目、代码文件），本机 .fenjue 归档只能作为补充并标注「本机归档」；去掉「凭证在哪」类的路径地图（P2-2）；每个量化数字都要有出处，否则删。
(3) 篇幅硬上限 5000 CJK（当前 5521），删冗余而不是删信息：先砍「本节读法」的同义复述、重复的状态说明、术语表里已在正文解释过的条目。
(4) 飞书形态：行内代码只留真命令与真代码，文件名/表名/服务名改粗体或纯文本（P1-9）；§1 结论表与 §5/§6 标题编号对齐（P1-7）。
(5) overview.svg 重画问题区：网关行四个框的 text x 必须随 rect 偏移，三个空框要么填内容要么删除；去掉影子模式的「正在返工」与旧阻塞点框，改为当前状态；两条穿模连线改走线；宿主层被箭头压住的标签挪开。改完用 rsvg-convert 渲成 PNG 自己看一遍再交，PNG 一并放 out/overview.png。
(6) Mermaid：参与者用 participant 别名（participant A as 名称）避免双引号渲进图里（P1-10），仍守飞书安全子集；用 bunx @mermaid-js/mermaid-cli 或语法自检确认能解析。
(7) 改后必报 diff：out/changes.md 逐条列「编号 → 原文 → 改后 → 依据」，未修的 P2 写理由；同步更新 sources.md 与 verify.md。
交付物放本单 out/：article.md、overview.svg、overview.png、plan.md、verify.md、sources.md、changes.md。只读仓库；不写凭证与 env 值；不写带用户名的绝对路径；不引站外链接。完成发 result。blocker 期间不发 result。
