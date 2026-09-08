# 引擎事件与外部会话控制（fj-as-controls-polish-dfcc）

- `AsProjectControls` 默认仅展示生命周期、错误/警告与权限事件；其它事件计数折叠，可用 localStorage 记忆的「显示全部」查看。每行含相对时间、方法、纯函数摘要及可展开原始 JSON，缓存仍限 100 条，兼容旧字符串缓存。
- 外部会话只展示当前权限徽标与只读文本；自建 AS 会话保留 select 和 Shift+Tab。保留 `data-as-system-log`、来源和权限 data 属性。
- 新增格式化单测；收编 E2E 覆盖过滤、逐行展开、刷新记忆、外部权限与手机溢出。项目 fixture 将原 system 调试消息改成 warning，继续验证可见事件的 SSE 链路；两个 regression.ts 无旧文案断言。
- `bunx tsc --noEmit` exit 0；`bun test` 285 pass / 0 fail；统一隔离前缀的 mobile-as-adopt/project 均完整 exit 0。3499 生产库备份 + 独立 fixture daemon 的新收编会话，两张 1440×900 截图已目检；未连接或写入生产 daemon。3471–3480、3499 无监听，公共锁已清。
- 初轮手机用通用 selector 点视口外节点失败，诊断轮人为终止；定位目标 nodeId、滚动到控件并按节点统计后完整复跑通过。原日志保留在契约 out。
- 证据：主仓 `.fenjue/tasks/fj-as-controls-polish-dfcc/out/result.md`、`bun-test.log`、`mobile-as-*.log`、`desktop.log`、`shots/`。
- Next：主控独立验收和合并；本分支提交，不 push、PR 或部署。
