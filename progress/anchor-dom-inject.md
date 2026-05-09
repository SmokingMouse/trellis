# Anchor 高亮 DOM 注入方案

## 背景

引用正文询问的 child anchor 高亮（amber `<mark data-child-id>`）和笔记摘录的 note anchor 高亮（emerald `<mark data-note-id>`）在富文本场景下经常失效：代码块、表格、链接、加粗、列表前缀、跨段选区。session 18 caveat 已经写过，session 17/18 next 都列了这是已知 follow-up。

根因：今天的 `injectHighlights` / `injectNoteMarks`（`NodeFullView.tsx:892-937`、`ChatNode.tsx:475`）在**源 markdown 字符串**上做正则匹配，但 anchor.text 是 `selection.toString()` 拿到的**渲染后 DOM textContent**——markdown 语法字符（``` ``` ` * _ # | [ ]```）在 DOM 里被剥掉，源里仍在，匹配必败。

## 设计：DOM textContent 上 indexOf + Range wrap

放弃在源 markdown 字符串注入 mark，改成等 markdown 渲染完成后在 DOM 上 imperative 注入。

### anchor schema 不变

ParentAnchor 仍只存 `selectedText`，Note 仍只存 `quotedText`。不加 prefix/suffix 字段、不动 DB schema、不动 API、不动 store。

唯一妥协：同一句 quote 在响应里出现两次时，只 wrap 第一处（同今天行为，session 18 caveat 已记录）。如果未来高频遇到再升级到 prefix/suffix 消歧版本——schema 加两个可选字段即可，平滑演进。

### 核心函数

新建 `lib/dom-mark-injector.ts`，导出两个函数：

```ts
type Anchor = { text: string; id: string };
type Spec = { dataKey: "childId" | "noteId"; anchors: Anchor[] };

// 把 anchors 描述的 text 范围在 root 内 wrap 成 <mark data-${dataKey}=...>。
// 多 spec 时按数组顺序 apply（先 note 后 child → child mark 嵌入 note mark
// 内，note 外 child 内，与今天字符串注入相反；视觉上 note 较大色块包住
// 较小的 child 色块，更直观）。
export function injectMarks(root: HTMLElement, specs: Spec[]): void;

// 把 root 内所有 <mark data-child-id> / <mark data-note-id> unwrap，
// 让 textNode 回到原 parent。effect cleanup 先跑这个保证幂等。
export function clearMarks(root: HTMLElement): void;
```

### 算法

**clearMarks(root)**:
1. `root.querySelectorAll('mark[data-child-id], mark[data-note-id]')` 拿到所有 mark
2. 对每个 mark：把 mark.childNodes 全部 insertBefore 到 mark 之前，再 mark.remove()
3. 调用 `root.normalize()` 合并相邻 textNode

**injectMarks(root, specs)**:
1. 对每个 spec 单独 apply（按数组顺序）：
2. **构造 textContent 索引**：TreeWalker(NodeFilter.SHOW_TEXT) 遍历 root，收集 `nodes: { node, start, end }[]` + 拼出 `fullText`。对子树内的 textNode 全收（包括已 wrap 在 mark 内的 textNode——上一轮 spec 注入留下的）。
3. **Normalize**: 把 fullText 的 `\s+` 收缩成单空格得到 `normFullText`，同时维护 `mapBack: number[]` —— `mapBack[i]` 是 normFullText 第 i 个字符在原 fullText 中的 offset。
4. **For each anchor**：
   - normalize anchor.text → `needle`（trim + `\s+`→空格）
   - `idx = normFullText.indexOf(needle)`，找不到 → skip
   - `[origStart, origEnd) = [mapBack[idx], mapBack[idx + needle.length - 1] + 1]` 即原 fullText 的字符范围
   - **二分定位 textNode**：在 nodes 上找到 origStart 落在哪个 textNode（startNode + offsetInNode），origEnd 同理（endNode + offsetInNode）
   - **splitText**：在 startNode 的 offset 处切开（拿到右半 = wrap 起点）；在 endNode 的 offset 处切开（拿到左半 = wrap 终点）
   - **TreeWalker 收集 [startNodeRight, endNodeLeft] 之间所有 textNode**（含起止）
   - **per-textNode wrap**：对每个 textNode，`const m = document.createElement('mark'); m.dataset[dataKey] = anchor.id; node.parentNode.insertBefore(m, node); m.appendChild(node)`
   - splitText 后索引数组失效，但只对当前 anchor 影响——下一个 anchor 我们用一个 try：每 anchor 注入完后**重建 textContent 索引**（重新跑 TreeWalker + normalize + mapBack）。anchor 数量小（一般 < 10），重建成本可忽略。

**为什么 per-textNode wrap 而不是 Range.surroundContents**:
- iOS Safari 上 `surroundContents` 对跨多个 element 的 Range 抛 InvalidStateError，不能用
- per-textNode wrap 对所有跨度都稳健

**嵌套语义（变更 vs 今天）**:
- 今天字符串注入"先 note 后 child"得到 `<mark child><mark note>text</mark></mark>`（child 外 note 内）
- 新 DOM 注入"先 note 后 child"得到 `<mark note><mark child>text</mark></mark>`（**note 外 child 内**）—— 因为后 wrap 的在外只在字符串拼接里成立；DOM 上后 wrap 的在 textNode 周围、被先前的 mark 包着
- 视觉影响：CSS `mark[data-note-id]:not([data-child-id])` 命中外层 emerald；内层 child mark 命中 `mark[data-child-id]` amber。重叠区域：内层 amber 显示在外层 emerald 之上（背景色 stack）—— 实际颜色还是 amber 优先（内层后 paint 盖外层）。今天嵌套行为也是 amber 显示，**视觉一致**。
- click 路由：closest("[data-child-id]") 不限层级，仍正确找到 inner child mark
- caveat 文字需要更新：今天写"child 外 note 内"，新方案是"note 外 child 内"。视觉/交互无差别，更新文字即可。

### 时序与触发条件（NodeFullView）

去掉 `responseWithMarks` useMemo + `injectHighlights` / `injectNoteMarks` 调用。markdown source 直接传 `node.response`。

新增 effect：
```ts
useEffect(() => {
  if (isStreaming) return;          // streaming 期间 textContent 直写、无 markdown DOM
  const root = bodyRef.current;
  if (!root) return;
  clearMarks(root);                 // 幂等
  const specs: Spec[] = [];
  if (noteAnchors.length) specs.push({ dataKey: "noteId", anchors: noteAnchors.map(a => ({ text: a.text, id: a.noteId })) });
  if (childAnchors.length) specs.push({ dataKey: "childId", anchors: childAnchors.map(a => ({ text: a.text, id: a.childId })) });
  injectMarks(root, specs);
  return () => clearMarks(root);
}, [isStreaming, node.response, childAnchors, noteAnchors]);
```

deps：
- `isStreaming` 切换 → 重跑（done 那帧首次注入）
- `node.response` 变化 → 流完成时 store commit 整段，effect 重跑（重新 clearMarks 再 inject）
- `childAnchors` / `noteAnchors` 数组引用变化 → 重跑（已通过 useMemo `Object.values(allNodes).filter(...)` 限定为相关变化）

cleanup return → component unmount / dep 变化时先把 mark 清掉，避免下次 re-apply 时残留。

### 时序与触发条件（ChatNode）

ChatNode 的 markdown body 也走 ReactMarkdown + `responseWithMarks` (`ChatNode.tsx:71-74, 246`)。同样改：去掉 `injectHighlights` 调用，markdown source 直接 `n.response`，加同结构 effect（无 noteAnchors）。

`onMarkClick` 不变，因为 mark 的 dataset 仍然是 `data-child-id`。

ChatNode compact 模式没渲染 markdown body，不受影响。

### scroll-to-anchor effect 兼容性

`NodeFullView.tsx:384-427` 的 pendingScrollAnchor effect 不动：仍 `querySelector("mark[data-child-id=...]" / "mark[data-note-id=...]")`。

唯一要确认：pendingScrollAnchor effect 跟注入 effect 之间的时序。两个 effect 都依赖 `node.response` / `isStreaming` 等。React 会在 commit 阶段按声明顺序跑 effect。**注入 effect 先声明、scroll effect 后声明**——保证注入完成后 scroll effect 才 query mark。会在代码组织上注意这个声明顺序。

scroll effect 的双 rAF 兜底（找不到 mark 就 clearScrollAnchor）保留——如果某个 anchor 真的命中失败（比如 normalize 后还是 indexOf 失败），scroll 找不到 mark 也不会卡住。

小改进：scroll effect 当前 `querySelector` 拿单个 mark，新方案下一个 anchor 跨段会有多个 mark element。**改成 querySelectorAll + 对所有 mark add anchor-pulse**（pulse 多段连闪），scrollIntoView 仍只对第一个。

### 副作用复核

| 副作用 | 处理 |
|---|---|
| 1. react-markdown 重渲染清 mark | effect deps 涵盖 response/anchors，重渲染后重跑 ✓ |
| 2. 时序竞争 | clear→inject 幂等，cleanup return 保证切节点干净 ✓ |
| 3. iOS Range.surroundContents 跨节点抛 | per-textNode wrap 不用 surroundContents ✓ |
| 5. mark 跨段视觉两条 | 同今天，无变化 ✓ |
| 6. 复制粘贴带 `<mark>` | 同今天，不处理 ✓ |
| 7. TreeWalker 成本 | 每 anchor 重建索引，10 anchor × 200 textNode 量级，~ms 级 ✓ |
| 9. 流式期间不显示 mark | 同今天，effect 跳过 isStreaming ✓ |

新副作用：嵌套结构 child/note 内外反转。视觉无差别（CSS 选择器命中相同），仅文档需要更新（旧 caveat 描述要订正）。

## 测试 case（人工浏览器实测）

`npm run dev` 起来后逐项验证：

| 类型 | 划词内容 | 预期 |
|---|---|---|
| 普通段落 | 一句话 | mark 命中（基线，今天也通过）|
| 跨段 | 跨两个段落 | mark 命中（今天 child 失败、note 偶通）|
| 代码块 | ```fenced 内的几行代码 | mark 命中（今天 100% 失败）|
| 行内代码 | 含 `code` 的句子 | mark 命中（今天可能失败）|
| 表格 | 表格里的一个单元格 / 跨单元格 | mark 命中（今天失败）|
| 链接 | 含 [文字](url) 的句子 | mark 命中（今天失败）|
| 加粗 | 含 **粗体** 的句子 | mark 命中（今天失败）|
| 无序列表 | `- item` 中的 item 文字 | mark 命中（今天失败）|
| 重复文本 | 同一段话出现两次 | 只 wrap 第一处（同今天，可接受）|
| 跳子点击 | 命中 mark 后点击 | 跳到子节点（行为不变）|
| 笔记跳回 + pulse | 抽屉点笔记跳回 | 滚到原句 + emerald pulse（行为不变，但命中率显著提升）|

`npm run build` 必过，无 TS 错。

## 工作量估算

- `lib/dom-mark-injector.ts`：~120 行（核心算法）
- `NodeFullView.tsx`：删 30 行字符串注入函数 + 改 ResponseBody effect ~25 行
- `ChatNode.tsx`：删 18 行字符串注入函数 + 改组件 effect ~15 行
- 实测 12 个 case：30 分钟
- 总计：**2-3 小时**
