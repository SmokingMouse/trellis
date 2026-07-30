# 线性 Thread 主视图 + 树缩略图（增量 2，给 Codex 的契约）

> 背景：project 模式基本是线性聊天，图状画布是过度抽象。给 project 加一个「线性 thread」主视图（像 ChatGPT 纵向铺开），分叉折成行内可展开，原图状画布缩为角落树缩略图导航。**只影响 project 模式**；chat/workspace 完全不变。

## 设计决策（已和用户确认，按此实现）

1. **project 默认进线性视图**；chat/workspace 保持现状（画布 + 全屏）。给一个「画布/线性」切换钮（project 才显示）。
2. **缩略图 = 角落 SVG 树**（复用 `layoutNodes` 的 dagre 坐标缩放绘制；不要嵌第二个 React Flow 实例）。点节点 → 切 activeNode + thread 滚到对应轮。
3. **分叉行内展开**：thread 里某节点若有「不在当前主线」的子（兄弟分支），显示「↳ N 个分支」可点 → 列出 → 点某分支 `setActiveNode(该分支)` → thread 重算走那条 lineage。
4. **线性 thread 取代 project 的全屏单节点视图**：thread 本身就是连续阅读，逐轮复用 markdown 渲染铺开。

## Store 改动（`stores/sessionStore.ts`）

- 加 `viewMode: "canvas" | "linear"` + `setViewMode(m)`。
- `loadSessionInternal` 里按 mode 初始化：`session.mode === "project" ? "linear" : "canvas"`（其余 mode 恒 canvas）。
- 持久化：扩展 `ViewState` 加可选 `viewMode`（`loadViewState`/`persistViewState` 带上；旧数据无该字段时按 mode 默认，向后兼容）。用户手动切了就记住。
- **不要动** `fullScreen`/`activeNodeId` 既有语义；canvas 模式行为完全不变。

## 组件 1：`components/LinearThreadView.tsx`

- **thread 计算**：以 `activeNodeId`（无则该 session 第一个 root）为锚：
  - `up` = `ancestorsOf(active, nodes)` 反转（root 在前）→ 到 active 的父。
  - `down` = 从 active 起，反复取「sibling_index 最小」的子，直到叶子。
  - `thread = [...up, active, ...down]`（root→tip 一条线性路径，穿过 active）。
- **逐轮渲染**（每个 thread 节点一块，纵向堆叠、整体可滚动）：
  - 问题：复用现有问题展示样式（「You」头 + question 文本；reference 节点渲染成参考卡片，简化可只显标题 + 链接）。
  - 回答：`<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeHighlight]} components={MD_COMPONENTS}>{node.response}</ReactMarkdown>`（与 NodeFullView 一致；import 同款）。
  - 工具调用：`<ToolCallsPanel toolCalls={node.toolCalls} />`（直接复用）。**S84 起改为 `<ToolTimeline>`（`components/tools/`），`ToolCallsPanel` 已删。**
  - 动作行：复用 `CliResumeButton`/`CopyButton`（可选，放每轮回答下）。
  - **分叉展开**：该节点的 children 里、不等于 thread 中下一个节点的那些 = 分支。有则渲染「↳ N 个分支」按钮，点开列出（每条显其 question 截断 + #index），点击 `setActiveNode(分支id)`。
  - streaming 节点：response 用流式文本（可简化为 `node.response` + 光标；live 实时不是本轮重点，done 后正确即可）。
- **头部**：会话标题 + 「🗺 画布」按钮（`setViewMode("canvas")`）。
- **滚动**：mount 及 activeNodeId 变化时，滚动到 active 节点对应的轮（用 ref + scrollIntoView）。
- **挂角落缩略图** `<ThreadMinimap />`（fixed/absolute 右下或右上）。
- 宽度居中阅读（如 max-w-3xl 居中），留出缩略图空间。dark mode 配齐（沿用现有 stone/indigo 配色）。

## 组件 2：`components/ThreadMinimap.tsx`

- 用 `layoutNodes(visibleNodes, undefined, { compact: true })` 拿坐标（或直接 dagre），求 bounding box，等比缩放进一个小框（约 200×300，右下角 fixed，半透明卡片背景 + 圆角 + 边框）。
- 画：节点 = 小圆点（active 高亮 indigo + 稍大；未读可 amber），边 = parentId 连线（细灰线）。
- 点圆点 → `setActiveNode(id)`（thread 会重算 + 滚动）。
- 可折叠（一个小钮收起/展开），不挡阅读。
- 纯 SVG，无第二个 React Flow。节点多时点小一点即可，不做缩放交互。

## page.tsx 整合（`app/page.tsx`）

- 现有：`fullScreen ? <NodeFullView/> : <Canvas/>`。
- 改为：
  - `session && mode==='project' && viewMode==='linear'` → `<LinearThreadView/>`（取代该 session 的 canvas+fullscreen）。
  - 否则维持现有 `fullScreen?<NodeFullView/>:<Canvas/>`。
- **画布→线性 切换钮**：在 Canvas 视图（project 时）放一个「线性」钮 → `setViewMode("linear")`。可放 Header 或 Canvas 角落。Header 里按 `session?.mode==='project'` 条件显示一个 viewMode 切换更统一——你定，保持简洁。
- 移动端：project 移动端也可用线性视图（线性视图本就适合窄屏，比画布好）；若复杂，移动端 project 默认 linear、不强制 fullScreen（`page.tsx` 现有移动端强制 fullScreen 的逻辑对 linear 跳过）。

## 约束 / 边界

- **只影响 project 会话**。chat/workspace 的 canvas + NodeFullView 全屏路径**零改动**。
- 不改解析/spawn/DB 任何后端。纯前端视图层。
- 复用既有：`MD_COMPONENTS`(`@/lib/md-components`)、`ToolCallsPanel`（S84 起是 `ToolTimeline`）、`ancestorsOf`(`@/lib/collapsed`)、`layoutNodes`(`@/lib/layout`)、`CliResumeButton`/`CopyButton`。不重造 markdown/工具渲染。
- 不破坏现有 store 选择器订阅模式（用 `useSessionStore((s)=>...)` 细粒度订阅，别整对象订阅致全 re-render）。

## 验收

- `npx tsc --noEmit` ✓ + `npm run build` ✓。
- 自检（grep/读代码）：viewMode 默认 project=linear；LinearThreadView thread 计算正确（穿过 active 的 root→tip 线性路径）；分叉「↳N」只在有非主线子时出现；缩略图点击切 active；page.tsx 仅 project+linear 走新视图、其余路径不变。
- **浏览器实测由主 agent（我）做**：真实「Analyze WeChat」线性会话 → 进入即线性 thread 纵向铺开、缩略图在角、切画布往返、（若有分叉会话）↳ 展开切 lineage。Codex 交代码 + tsc/build + 自检即可。

## Stop / Pause

- Stop when：tsc + build ✓ + 自检过。
- Pause if：发现要改 chat/workspace 路径或后端才能跑通（边界判断错）；或 store viewMode 持久化破坏既有 fullScreen/activeNodeId 恢复。
