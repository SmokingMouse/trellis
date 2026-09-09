目标：实现 UI 体检「方向 3 · 待办层」——把「等你处理」从会话正文里提出来，桌面 Header 下方一条常驻横条，跨会话列出所有待处理的审批卡与提问卡，可跳转、可就地处理；同时把审批卡按钮改成主次分明。用户已拍板。

## 输入（先读）

- 体检报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-ui-audit-7b23/out/ui-audit.md`：§3 P1-4（桌面无常驻提示、审批卡落在折叠线下）、P1-5（三键等权、「本轮总是允许」最宽）、§6 方向 3（含手机侧可复用的等待横幅模式）、§5 值得保留项；截图 d-12 / d-13 / d-14。
- 手机壳裁决 `progress/mobile-shell.md`（手机首屏信息裁决，等待横幅归属）。
- 代码：`components/InteractionForm.tsx`（审批/提问卡与三个动作）、`components/LinearThreadView.tsx`、`components/Header.tsx`、`components/MobileOverflowMenu.tsx`、`components/SessionSidebar.tsx`（会话行的 `indicatorStatus`「等你回答」已有数据来源）、`stores/sessionStore.ts`、`app/api/nodes/[id]/respond/route.ts`、`app/api/nodes/[id]/stream/route.ts`、`lib/server/as-project.ts`（AS 绑定会话的 pendingRequests 与双端审批）、`lib/server/as-adopt.ts`（收编会话同样有审批）。
- 现有回归：`scripts/mobile-verify/mobile-followup-approval.sh`（追问/审批/Composer）与 `mobile-as-project.sh`（双端审批）。

## 要求

1. **数据面**：一个跨会话的「待处理」聚合（run-bus 的 interaction pending + AS 绑定/收编会话的 pendingRequests），随现有 SSE / 会话列表刷新机制更新，**不新增轮询**；每项含会话、节点、类型（审批 / 提问）、摘要、发起时间。给出 API 或 store 层的实现说明。
2. **桌面待办条**：Header 下方全宽横条，只在有待处理项时出现；每项一行：类型徽标 + 会话名 + 摘要 + 「去处理」（跳到该节点并滚到卡片）+ 审批类可就地「允许一次 / 拒绝」；多项时折叠为「N 项等你处理」可展开；键盘可达；处理后即时消失（含另一端处理的撤卡，复用 `serverRequest/resolved` 语义）。
3. **审批卡按钮层级**（P1-5）：「允许一次」主按钮、「拒绝」次按钮、「本轮总是允许」改为不显眼的第三级（文字按钮或放进「更多」），且宽度不再最大；手机三键同样调整但保持 44px 触控高度。
4. **手机**：复用现有等待横幅模式，不改首屏结构裁决；待办条在手机上折叠成横幅一行，点开 sheet 列表。
5. 不动侧栏结构、树面板、地图；不动飞书/任务链路；不加依赖。

## 验收

- 生产库快照隔离实例（端口 3505）+ 测试桩（`mobile-followup-approval.sh` 用的流式测试桩构建方式 `NEXT_PUBLIC_TRELLIS_VERIFY=1`）截图：桌面 1440×900 待办条单项态 / 多项折叠态 / 展开态 / 就地允许后消失；审批卡新按钮层级；手机 390×844 横幅与 sheet。
- `bunx tsc --noEmit`、`bun test` 全绿，新逻辑有单测（聚合、撤卡、按钮层级）；11 条手机脚本统一前缀独占跑绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`），`mobile-followup-approval.sh` 里加待办条与按钮层级断言；跑完 3471–3480 与 3505 无监听、锁已清。
- 提交到本 worktree 分支 `feat/pending-bar`，工作树干净；不 push、不 PR、不部署；**不改 `progress/README.md`**。**不发 partial result**，完成后发唯一一封 done，result.md 附截图与数据面说明。
