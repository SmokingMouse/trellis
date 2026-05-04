# Stage 11: 发送 / 取消 UX

## 动机

两个用户痛点：
1. **误触发送**：当前所有输入框 `Enter` 直发（`QuestionInput.tsx:24`、`NodeFullView.tsx:478` / `:538`）。一不小心就开喷，浪费 token、污染树。
2. **无法中止**：流式开始后无停止按钮、无快捷键，只能干等到 done 或刷页。退页等于"看着钱烧完"。

根因：发送门槛太低 + 启动后缺逃生通道。

## 设计

### 发送行为

| 快捷键 | 行为 |
|---|---|
| `Cmd/Ctrl + Enter` | 发送 |
| `Enter` | 换行 |
| `Shift + Enter` | 换行（兼容历史习惯，UI 提示文案同步更新） |

桌面端默认 Cmd+Enter；移动端没有键盘快捷键问题，"发送"按钮即可。
不做"延迟发送 + 撤回浮条"——先用快捷键约束，效果不够再加。

### 流式中止

发送按钮在 `status === "streaming"` 时**原地切换**为 ⏹ 停止按钮（同位置、同尺寸，避免布局抖动）。配合：

- `Esc` 全局监听：聚焦的 streaming 节点 → 中止；多个 streaming 时只中止当前 active 节点。
- 中止后保留：(1) 已生成的 partial response 落 DB，状态置 `error`，`error_message = "aborted"`；(2) 原始 prompt 回填到来源输入框，方便编辑后重发。

### Retry 入口

中止节点和 error 节点共用一套 retry 路径（`resetNodeForRetry`，已存在）。中止显式不算"失败"，但走同一物理路径降低维护面。UI 上 `aborted` 显示为灰色"已停止"标签 + 重发按钮，区别于红色 error。

## 实施步骤

按依赖顺序：

1. **Server abort 落地**（`app/api/chat/route.ts`）
   - SSE handler 监听 `request.signal.aborted` → kill provider stream（claude/codex 子进程 SIGTERM；mock 关定时器）
   - 收到 abort 信号：`finalizeNode` 写入当前 partial + `status="error"` + `error_message="aborted"`
   - **TODO**：确认 Next.js App Router runtime=nodejs 下 `request.signal` 在客户端 abort 时确实触发（实测一次）

2. **Client AbortController**（`stores/sessionStore.ts`）
   - 每个 streaming nodeId 维护一个 `AbortController`，存到 module-level `Map<nodeId, AbortController>`（不放 store，避免 Zustand 序列化）
   - `streamRoot` / `streamBranch` / `retry` 创建时存入；done/error/aborted 时清理
   - 新增 action `abortStream(nodeId)` → `controller.abort()` + 清 stream-bus pending

3. **UI 切换**（三处输入框 + ChatNode/NodeFullView 顶部）
   - `QuestionInput.tsx`、`NodeFullView.tsx` 两处：keyDown 改判 `e.key === "Enter" && (e.metaKey || e.ctrlKey)`
   - 提示文案：`Enter` → 换行，`⌘↩` → 发送
   - 发送按钮：streaming 时换 ⏹ 图标 + `onClick={() => abortStream(activeStreamingId)}`
   - 全局 `Esc` 监听：放在 Canvas 或 page 顶层，找到当前 active 节点的 streaming 状态，调 `abortStream`

4. **Aborted 状态视觉**
   - `NodeStatus` 不新增枚举（保持 `streaming/done/error`）；用 `errorMessage === "aborted"` 区分
   - ChatNode：error 红边框 → 检测 aborted 走灰边框 + "已停止"文案
   - NodeFullView：retry 按钮文案在 aborted 时为"重新发送"

## 测试用例

- 桌面 `Enter` 不发送、`Cmd+Enter` 发送、`Shift+Enter` 换行
- 流式中点 ⏹ → 立即停止，partial 保留，prompt 回填输入框
- 流式中按 `Esc` → 同上
- 中止后点重发 → 走 retry 路径，正常出回复
- 多个并发 streaming（多节点同时跑）：`Esc` 只中止当前聚焦的；其他不受影响
- 移动端：⏹ 按钮可用，`Esc` 无感（无键盘）

## 不在这次 scope

- "撤回发送"（2 秒延迟浮条）
- 快捷键自定义（用户能否切回 `Enter` 直发）
- aborted 节点的清理策略（保留 vs 自动删除）

留待用户实测后再判断是否真有需求。
