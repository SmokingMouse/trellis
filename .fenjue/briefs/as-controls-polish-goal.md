目标：收编会话（origin=external）与 AS 绑定会话的节点视图里，`components/AsProjectControls.tsx` 那块「系统日志」把 daemon 透传的原生引擎事件（`thread/engineEvent`：item/completed、hook/started、hook/completed 等）按 `subtype: JSON.stringify(payload)` 原样堆成 86 行 JSON，用户点开一看是乱码。把它改成给人看的，并收紧外部会话上的控制。

## 改法（小改，不动协议、不动 daemon）

1. **过滤**：默认只保留「没有对应 item 投影」的事件——引擎生命周期（started/exited/restart/systemError）、错误与警告、权限变更；`item/*`（已投影成节点动线）、`hook/*`、`turn/*`、reasoning/delta 之类的高频回显默认不进列表，只在标题里以「已折叠 N 条调试事件」计数。加一个「显示全部」开关（默认关，localStorage 记忆）。
2. **人话化**：每行 = 相对时间 + 方法 + 一句摘要（如「hook postToolUse 完成 · 12 ms」「sleep 45 s」「引擎退出 (143)」），摘要函数 `lib/as-engine-event-format.ts` 纯函数 + 单测覆盖 sleep / hook / item/completed / engine exit / 未知事件兜底；每行可展开看原始 JSON（`<details>` 嵌套或点击切换），整块仍默认折叠，标题改「引擎事件（N）」。上限 100 条不变。保留 `data-as-system-log` 等测试用 data 属性（`scripts/mobile-verify/as-project-regression.ts`、`as-adopt-regression.ts` 若有断言先查再改）。
3. **外部会话的控制收紧**：`external` 为真时权限模式只显示当前值（文本 + 徽标），不渲染 `<select>` 与「Shift+Tab 切换」——别人的坐席线程不该从主页改权限；仍显示来源行与状态。AS 绑定的 Trellis 自建会话行为不变。
4. 手机与桌面都看一眼：`mobile-as-adopt.sh`、`mobile-as-project.sh` 统一前缀独占各跑一次绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`），脚本若断言旧文案「系统日志」按新文案改并写明；跑完 3471–3480 无监听、锁已清。生产库快照隔离实例（端口 3499）对一个收编会话截图两张：默认折叠态、展开后的人话列表，桌面 1440×900。

## 交付

- `bunx tsc --noEmit`、`bun test` 全绿；提交到本 worktree 分支 `fix/as-controls-polish`，工作树干净；不 push、不 PR、不部署（主控合并）。
- `out/result.md`：改动清单、过滤规则表（哪些方法默认隐藏）、命令与 exit、截图路径。**不发 partial result**，完成后发唯一一封 done。
