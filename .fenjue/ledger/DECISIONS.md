# 焚决台账（append-only，每单 close 一行）

- [fj-mt-spike-54c5] 多租户容器方案 spike:容器出站网络 / claude CLI / ttyd 实测报告 | accepted | reworks=0 | 2026-08-28T12:59:56+08:00 | d25858d3ac23
- [fj-mt-gateway-0042] 多租户 M2:租户网关(认证/邀请/cookie 翻译/HTTP+SSE+WS 反代)+ launchd 模板 | accepted | reworks=0 | 2026-08-28T13:17:41+08:00 | 56c2efb926b2
- [fj-mt-image-681e] 多租户 M1:trellis 租户镜像(Dockerfile+entrypoint)+ tenantctl 编排 CLI | accepted | reworks=0 | 2026-08-28T13:25:11+08:00 | 879273a510f1
- [fj-mt-m3-3073] 多租户 M3:tenantctl 增补 creds-share(共享凭证注入/撤销)与 backup 子命令 | accepted | reworks=0 | 2026-08-28T13:32:50+08:00 | ecd83b35d56f
- [fj-lark-bot-28f1] 飞书机器人载体：注册/绑定 Bot + 飞书双向对话（WS 长连接） | accepted | reworks=0 | 2026-08-28T13:42:13+08:00 | 358a07f39073
- [fj-admin-ui-2029] trellis 管理页(/admin)+ 设置页共享区,消费 /__gw/api | accepted | reworks=1 | 2026-08-28T17:37:53+08:00 | 2df5cb8c1a45
- [fj-gw-portal-be6e] 网关控制面:role + 邀请码自助注册 + admin/共享池 API + 注入编排 | accepted | reworks=0 | 2026-08-28T17:39:49+08:00 | ccddea5b08c0
- [fj-task-lark-landing-7ecd] 定时任务落进飞书会话：任务绑定飞书落点 → 每次 run 在该 chat 的会话里长新树 → 回答推送到群/私聊 → 话题追问接叶子、引用即分支 | accepted | reworks=1 | 2026-09-02T22:05:45+08:00 | 5a0c1566bb9c
- [fj-task-lark-review-edb7] 异源 review：审「定时任务落进飞书会话」实现（fj-task-lark-landing-7ecd，commit 6c75fcc，diff 72af75e..HEAD），结论写 out/review.md | accepted | reworks=0 | 2026-09-02T22:05:45+08:00 | e3b0c44298fc
- [fj-task-lark-rereview-4c67] 复审增量：返工 commit 4c518ec（diff 6c75fcc..4c518ec）是否真修了 F1/F2/F5/F6/F7/F8 且无回归，结论写 out/review.md | accepted | reworks=0 | 2026-09-02T22:05:45+08:00 | e3b0c44298fc
- [fj-task-lark-ship-610e] 合并 + 上线：推 feat/task-lark-landing → 开 PR → merge 进 main → 本地 main ff → make deploy（smoke + 自动回滚）→ 验活（网关 / 飞书重连 / 迁移落地） | accepted | reworks=0 | 2026-09-02T22:39:45+08:00 | e3b0c44298fc
