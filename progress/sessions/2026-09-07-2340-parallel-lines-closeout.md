# S145 · 2026-09-07 21:30–23:40 · 三条线并行收口（嵌套三轮复核 / agent-server 实跑 / 影子模式）

## 起因

用户两句话定了这一段的节奏：「但是不同的 worktree 好像是隔离开的，我希望是像咱们实际的项目这样组织嵌套结构」→ 侧栏 Herdr 分组改嵌套；「你为啥不同步跑呢」→ 放弃无依据的串行，三条线同时推进。

## 做了什么（全部由坐席执行，leader 只派单、裁 blocker、独立核验）

### 线一 · feat/herdr-bridge 侧栏「仓库 → worktree → 会话」嵌套

- hb-nest（codex gpt-6-astra）：三级树、共享折叠记忆、两级计数冒泡、fake-herdr 三工作区 fixture。验收过。
- hb-nest-review（Opus）：需返工——P1-1 排序随 pane 状态重排、P1-2 新 workspace 最长 60 秒掉平铺区，P2 四条。
- hb-nest-fix：六条按 P 编号小步提交。hb-nest-review2：六条全过，新引入 N1（非 git workspace 省略 `worktree` key 被当成元数据未知 → 每条 `workspace_updated` 强制全量 `session.snapshot`）。
- hb-nest-fix2：判据改为「本地不认识该 workspace 或元数据确实变化」，风暴反例转正单测。hb-nest-review3：通过。
- 3490 真机实例重建两次（hb-instance-rebuild → 79ff715；hb-instance-rebuild2 → 19d0438，pid 13393，停机 13 秒），三地址 200，iPhone 截图确认三级嵌套、主 checkout 置顶。
- 复核者口径提示：主 checkout 置顶 + 角标只在折叠态显示，合成效果是全展开时仓库/worktree 层无聚合信号。与项目树约定一致，未改；用户真机觉得找不到人可考虑小圆点。

### 线二 · sm-toolkit feat/agent-server 真引擎实跑

- as-smoke（codex）：Sonnet 与 gpt-6-astra 各 4 turn，审批、双客户端 attach、sinceSeq 回放、interrupt 排队均有真实帧证据；此前所有测试与两轮 review 均为 MockEngine，这是首次真实触发。
- 发现 P1-1（测试客户端误批 Claude 写到 HOME 的文件，原生已标路径越界；测试侧责任，文件已清理）与 P2-1（codex app-server 回显 clientInfo 名为 userAgent，版本解析只认 codex 前缀 → 误报 unknown）。
- as-fix3：优先读 `thread.cliVersion`，16 项版本矩阵单测；带路径校验客户端补跑 Claude 在 cwd 内的 fileChange 审批通过。HEAD 94b0255，未合 main、未 push、未发包。

### 线三 · feat/agent-server-client 影子模式（迁移第一步）

- as-migrate-1（codex）：as-client、/api/as/threads 与 SSE 续传、/console/threads 只读页、mobile-as-shadow.sh E2E。验收过。
- as-migrate-1-review（Opus）：需返工——P0-1 package.json 写死指向 sm-toolkit herdr worktree 的绝对路径（干净 clone 连 bun install 都挂）；P1-1 postinstall 缺文件裸崩；P1-2 观察者无退避无开关每 5 秒刷 warn；P1-3 2 秒轮询重推整份快照 100 KB/s；P2 六条。
- **leader 裁决（可逆）**：依赖改为 vendor 内置构建产物（`vendor/agent-server`，`file:./vendor/agent-server`，同步脚本记源 commit），去掉全局 overrides；观察者默认不启动（`TRELLIS_AS=on` 或配置 socket 才起）；「不装 sm-toolkit 的干净 clone 能 install + build」作硬验收。正式发 npm 是对外动作，留给用户。
- as-migrate-1-fix（16 提交）→ as-migrate-1-review2 通过；遗留 P1-3R（会话产出中仍 80 KB/s 重推 inProgress 载荷，根因 AS v1 缺只读增量通知）记 backlog；N1–N9 卫生项由 as-migrate-1-polish 一次清净（vendor 内容字节 663 KB → 391 KB，LICENSE、依赖表从上游 manifest 生成、默认路径去用户名、E2E 脚本去一次性目录、TRELLIS_AS 文档与 .env.example、off 硬关闸、退避期防抖重连、底部轻点不关跟随）。HEAD b691c8e。

### 架构介绍文

- 用户要求「让 gemini 写一篇现在的架构介绍」→ 追加「使用 write-craft 写，写到飞书云文档里」。
- arch-doc（Gemini 3.8 flash，模型从会话记录核实）出事实稿 334 行、七大节、两张 mermaid、七十余处仓内路径指向，作 writecraft 素材（`.fenjue/archive/fj-arch-doc-c32f/out/architecture.md`）。
- 已按 write-tech-design 出 Design Brief + 2B 骨架给用户，等点头；飞书用户身份过期（默认 bot 建文档 + member-add full_access，或用户 `lark-cli auth login`）。建文档前必走 write-gates 预览卡。

## 实弹经验（已回填 seats.md 的不重复）

- 同一 worktree 里两单先后跑，后一单的 settle 会把前一单的提交判成越界：把 task.json `base_commit` 改成当前 HEAD 再 `fj settle --force`。
- 留用坐席关单后仍会晚发一封信重建 `.fenjue/tasks/<cid>/`：mail 并入 archive 的 `mail-late-resend.ndjson` 后 rmdir。
- codex `-a never` 仍会拒绝 `rm -rf` 类命令：契约里预写「用 mktemp 唯一目录 + 只清理自己创建的」等价做法。
- macOS grep `-r .` 输出不带 `./` 前缀，verify 里按 `^\./` 过滤会失效；按明确文件名 grep。

## Next

- 用户真机反馈 → feat/herdr-bridge 合并上线（重建 + 全套脚本 + PR）。
- 用户决定：影子模式合并；agent-server 合 main / push / 发包或继续 vendor；架构文 Brief 点头后起 writecraft 成稿 → Opus 六维审阅 → 飞书 XML 导入（预览卡确认）。
- backlog：AS 协议加只读 pending-request 通知，删掉影子模式 2 秒轮询。
- 空闲留用坐席四个（trellis-hb-review、trellis-hb-nestfix-impl、trellis-as-migrate-impl、trellis-as-review），收尾时 `fj seat retire`。
