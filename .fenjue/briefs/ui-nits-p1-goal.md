目标：修 UI 体检报告第一批里的三个单点缺陷（几行量级，但用户每天看得见），不做任何重设计。

体检报告：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-ui-audit-7b23/out/ui-audit.md`（截图在同目录 `shots/`），先读 §3 对应条目再动手。

## 三条

1. **P1-8 侧栏顶部把 Herdr 裸异常串印进导航区**：`ENOENT: ENOENT: no such file or directory, stat '…/herdr.sock'` 四行、含绝对路径、含重复前缀。组件 `components/HerdrSidebarGroup.tsx`、`hooks/useHerdrFleet.ts`。改成一行人类可读的降级说明（例如「Herdr 未运行」+ 一个可展开/悬停看原始错误的小入口），去掉重复前缀与绝对路径；原始错误仍可在 devtools/日志里拿到。补一条单测或组件测试覆盖「socket 不存在」这个分支的文案。
2. **P1-10 `settings/machine` 页单位错误**：把 GB 当 TB 显示（「内存 96.7% · 61.9 TB / 64.0 TB」「磁盘 42.7% · 395.8 TB / 926.4 TB」）。看 `app/api/machine-resources/route.ts` 与 `app/settings/machine/page.tsx` 哪一层换算错，修正并用一个格式化函数（≥1024 GB 才升 TB），单测覆盖 GB/TB 两档与边界。
3. **P2-1 新会话首屏文案「默认 Claude Sonnet」与 Header 显示的 Opus 不一致**：`components/QuestionInput.tsx:626` 附近。文案改为读取当前实际默认模型（与 Header 同一来源），没有硬编码模型名；找不到来源就显示「使用当前默认模型」并去掉具体名字。

## 约束

- 只改上述三处及其测试；不动布局、不动样式体系、不加依赖。
- `bunx tsc --noEmit`、`bun test` 全绿；`git diff --check` 干净；提交到本 worktree 分支 `fix/ui-nits-p1`，工作树干净。
- 用隔离实例（`bun run build` 后生产库快照 `next start`，端口 3492，起法见体检报告附录「可复现命令」；不碰 3088、不连生产库本体）截三张修后截图放 `out/shots/`：侧栏 Herdr 降级文案、machine 页单位、新会话首屏文案，桌面 1440×900。结束后杀进程、确认 3492 无监听。
- `out/result.md`：每条改了什么、命令与 exit、截图路径。不 push、不 PR、不部署（主控合并）。
