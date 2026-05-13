# Stage 16: 跨 session 全文搜索（FTS5 + ⌘P）

## 动机

Trellis 已积累几十个 session，前几周问过的概念、抓过的参考材料、记的笔记，靠 SessionPicker 的标题列表已经回不去——标题只是一句话，里面的具体细节没有索引。GPT 网页客户端那边对应的痛点是「上周问 ChatGPT 的那段，标题忘了」——OpenAI 加搜索的时间比 GPT 上线晚了好几年，Trellis 现在补这一刀是直接对齐 GPT 客户端 80% 体验的临门一脚（roadmap 第一波第三步）。

## 设计

### 索引存什么

四种文本是用户写过或抓回来的，都要被命中：

| 来源 | SQL 字段 | 备注 |
|---|---|---|
| nodes.question | qa / reference 都有；reference 是空串 | 短文本，权重最高 |
| nodes.response | qa 的回答正文；reference 是空串 | 最长文本，命中频率最高 |
| nodes.ref_content_md | reference 抓回来的 markdown | 用户附带的"原文" |
| notes.quoted_text | 用户手动摘录 | 用户已经标过"重要" |

session.title 不进 FTS——它本来就在 SessionPicker 文本里能匹配，没必要进倒排索引。topic_label 同理（短、已能通过 question/response 命中）。

### Schema

**单一 FTS5 表 + contentless 模式**：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  text,
  source_kind UNINDEXED,    -- 'node_question' | 'node_response' | 'node_reference' | 'note'
  source_id UNINDEXED,      -- node.id 或 note.id
  session_id UNINDEXED,     -- 冗余存储，避免每条搜索结果再 JOIN sessions
  tokenize = 'trigram'
);
```

- **trigram tokenizer**：FTS5 内置，三字符滑窗。中文「图片输入」会切成「图片输」「片输入」三元组；英文「tokenize」会切「tok」「oke」「ken」「eni」「niz」「ize」。中英文都能子串匹配，是 Notion / Linear 这类工具的同款选择。
- **代价**：索引体积比 unicode61 大 2-3x。短期不是瓶颈（用户百万 token 的 session 索引也就几 MB）。Q3 真膨胀了再做 vacuum。
- **关键约束**：trigram 至少 **3 字符** query 才能匹配。`"图片"` 只有 2 字符 → 0 结果。UI 必须显式提示「至少输入 3 个字符」，不要静默返空。
- **UNINDEXED 列**：source_kind / source_id / session_id 不进倒排索引，只是 row-level 的元数据 lookup。比 join 主表快、内存占用低。
- **contentless 不显式声明**：单纯不写 `content=''` 也行——FTS5 默认会拷贝一份 text。改 `content=''` 节省一倍空间但需要 trigger 维护 rowid 映射。我们走默认（带内容）路线，因为 ref_content_md 抓回来后基本只读、不修改；response 一旦 done 也基本不变。空间换简洁。

### 同步策略：显式 upsert，不是 trigger

考虑过两条路：

**A: SQL trigger 监听 nodes/notes 表 INSERT/UPDATE/DELETE**
- 优点：自动，repo 层零侵入
- 缺点：每条 `appendNodeResponse(delta)` 都会触发 update —— 流式期间一秒几十次写 FTS。trigram 倒排索引重建有成本。

**B: 在 repo 层显式调用 syncToFts(args)**（最终选择）
- 在 `finalizeNode` 调用（status 翻 done/error 那一刻才入索引）
- 在 `createNote / deleteNote` 调用
- 在 `createReferenceNode / finalizeReferenceFetch / refreshReferenceNode` 调用
- 在 `deleteNodeSubtree / deleteSession` 调用清理
- `createSessionWithRoot / createRootInSession / createBranchNode` **不调用**——response 还是空串，等 finalize
- `resetNodeForRetry` 清掉旧 response 的 FTS 记录（重试期间不显示在搜索里，避免命中已被清空的旧文）

理由：流式期间没人搜索，搜了也没意义。`finalizeNode` 才是真正"有值"的入索引时刻。代码侵入面 ~10 处，全在 repo.ts 同一文件，可读性可控。

### 数据流细节

**节点入 FTS 的两条记录**：

```
finalizeNode(nodeId) →
  upsert(source_kind='node_question', source_id=nodeId,
         session_id=sessionId, text=question)
  upsert(source_kind='node_response', source_id=nodeId,
         session_id=sessionId, text=response)
```

question + response 拆两条，因为搜索结果展示时要区分「在问题里命中」vs「在回答里命中」。snippet 也只在命中的那条文本上取，不混淆。

**reference 节点**：

```
createReferenceNode / finalizeReferenceFetch →
  upsert(source_kind='node_reference', source_id=nodeId,
         session_id=sessionId, text=ref_content_md)
```

reference 的 question/response 都是空串，不入索引。

**delete 路径**：

```
deleteNodeSubtree(nodeId) →
  收集 subtree ids → DELETE FROM search_index WHERE source_id IN (...)

deleteSession(id) →
  DELETE FROM search_index WHERE session_id = ?
```

session FK 是 CASCADE，但 FTS 是虚拟表不接 FK 约束，必须手工删。

### 首启动回填

migration 加完 search_index 表后：

```ts
const indexed = db.prepare("SELECT COUNT(*) AS n FROM search_index").get();
const haveData = db.prepare("SELECT COUNT(*) AS n FROM nodes").get();
if (indexed.n === 0 && haveData.n > 0) {
  // 一次性回填
  backfillSearchIndex(db);
}
```

`backfillSearchIndex`：

```sql
-- qa 节点的 question
INSERT INTO search_index(text, source_kind, source_id, session_id)
SELECT question, 'node_question', id, session_id
FROM nodes WHERE kind = 'qa' AND question != '';

-- qa 节点的 response（仅 done 的，streaming/error 的 response 不可信）
INSERT INTO search_index(text, source_kind, source_id, session_id)
SELECT response, 'node_response', id, session_id
FROM nodes WHERE kind = 'qa' AND status = 'done' AND response != '';

-- reference
INSERT INTO search_index(text, source_kind, source_id, session_id)
SELECT ref_content_md, 'node_reference', id, session_id
FROM nodes WHERE kind = 'reference' AND ref_content_md IS NOT NULL;

-- notes
INSERT INTO search_index(text, source_kind, source_id, session_id)
SELECT quoted_text, 'note', id, session_id
FROM notes;
```

包成一个 transaction，几百毫秒搞定（千条记录级别）。完成后下次启动 indexed.n > 0，跳过回填。

### Search API

```
GET /api/search?q=<query>&limit=20
```

返回：

```ts
type SearchResult = {
  sessionId: string;
  sessionTitle: string;
  sessionMode: string;            // 'chat' | 'workspace' | 'project'
  sessionWorkspacePath: string | null;
  hits: SearchHit[];              // 同一 session 内的命中折叠在一起
};

type SearchHit = {
  sourceKind: "node_question" | "node_response" | "node_reference" | "note";
  sourceId: string;               // node.id 或 note.id
  snippet: string;                // 含 <mark>...</mark> 高亮的截断片段
  matchText: string;              // 去掉 <mark> 后的原始片段，给 NodeFullView 注入 mark 用
};
```

repo.ts:

```ts
export function searchAll(query: string, limit = 50): SearchResult[]
```

实现要点：
- query trim、长度 < 3 → 返 []（API 也 short-circuit，client 已经做了 hint）
- query 转 FTS5 安全形式：单引号 escape、保留中英文字符，去掉 FTS5 特殊操作符（`"` `*` `(` `)`）避免 syntax error
- ORDER BY `bm25(search_index)` 升序（FTS5 中 bm25 越小越相关）
- 一次 SQL：FTS 表 JOIN sessions 拿 title/mode/workspace_path
- snippet 用 `snippet(search_index, 0, '<mark>', '</mark>', '…', 12)` —— 12 token 上下文
- JS 层把同 session 的多条 hits 折叠成一个 SearchResult

### UI: SearchModal

新建 `components/SearchModal.tsx`：

```
┌──────────────────────────────────────────┐
│ 🔍 [输入框]                       Esc 关 │
├──────────────────────────────────────────┤
│ 全部  Chat  Workspace  Project           │  ← facet（按 session.mode 过滤）
├──────────────────────────────────────────┤
│ Session A — 5月10日 · workspace · trellis│
│   💬 你刚才提的图片输入想法 …image…       │
│   📝 [笔记]…粘贴的方式 vs 拖拽…           │
│                                          │
│ Session B — 4月22日 · chat                │
│   💬 …attachment design…                 │
│   📄 [参考]…vision API docs…              │
└──────────────────────────────────────────┘
```

- **触发**：全局 `keydown` listener 监听 `⌘P` (Cmd/Ctrl+P)，`e.preventDefault()` 覆盖浏览器打印。打开 modal、focus 输入框。Esc 关。
- **debounce**：输入 200ms 防抖再发请求。短 query（< 3 字符）显示「至少输入 3 个字符」提示，不发请求。
- **facet**：默认「全部」。点 mode chip 高亮 + 客户端过滤（不再发请求，节省往返）。
- **结果分组**：按 sessionId 折叠，每组顶部显示 session 元信息（title + mode chip + workspace basename）。
- **每条 hit 行**：左侧 icon（💬 question / 💭 response / 📄 reference / 📝 note），中间 snippet（`<mark>` 渲染成 amber 高亮 span），点击触发跳转。
- **键盘导航**：↑↓ 选行，⏎ 跳转。第一行默认选中。

### 跳转 + pulse

store 加 action：

```ts
jumpToSearchHit({ sessionId, nodeId, matchText, matchKind }: {
  sessionId: string;
  nodeId: string;
  matchText: string;  // snippet 去 <mark> 后的纯文本
  matchKind: "question" | "response" | "reference" | "note";
})
```

行为：
1. 如果 `session.id !== sessionId` → `loadSession(sessionId)`（已有 → 直接 set）
2. `setActiveNode(nodeId)` + `setFullScreen(true)`
3. `set({ pendingScrollAnchor: { kind: "search", nodeId, matchText, matchKind } })`
4. 关闭 SearchModal

`pendingScrollAnchor` union 加第三个 case `kind: "search"`。NodeFullView 的 ResponseBody（response 注入 effect）和 QuestionBlock（question 注入）分别处理：

- `matchKind === "response"` → ResponseBody 调 `injectMarks(root, [{ anchorText: matchText, kind: "search" }])` + 滚动 + emerald pulse
- `matchKind === "question"` → QuestionBlock 同款处理
- `matchKind === "reference"` → reference 节点的 markdown 渲染区（如果 reference 节点本身就是 root，NodeFullView 自带 ref 渲染）
- `matchKind === "note"` → 命中是笔记本身，点击应该是「跳到笔记的 source 节点 + pulse 笔记原句」=== 已有的 jumpToNoteSource 路径。这条 hit 行直接调 `jumpToNoteSource(noteId)` 而非走 jumpToSearchHit，UI 层分流。

**snippet → matchText 的退化处理**：FTS5 snippet 含 `…` ellipsis、可能跨段，注入到 markdown DOM 时大概率找不到完整匹配。`lib/dom-mark-injector.ts` 已经支持 `\s+` flex 匹配，但对 ellipsis 没办法——传给 injector 前需要清洗：

- 去掉首尾 `…`
- 去掉中间残留的 `<mark>` / `</mark>`（防御性）
- 如果清洗后长度 < 6 字符（trigram 边界值），降级为「跳节点不 pulse」

注入失败的退化 = v1 体感（已有的兜底），不崩。

### 性能 / 容量

- 索引规模：千节点 × ~5KB 平均 response = 5MB raw text；trigram 倒排放大 2-3x = 10-15MB 索引。再加 reference 大文档（动辄 50-200KB）几十个，整体 50-100MB 级别。SQLite 单文件远未到瓶颈。
- 查询延迟：trigram MATCH 一千行级别 < 5ms；万行级别 < 50ms。debounce 200ms 完全够。
- 回填时间：现有数据库（DB_PATH `~/.trellis/data.db`）查 nodes COUNT 估算。我现在的 trellis 大概几十个节点 + 几十个笔记，回填应该 < 100ms。

### 不在 scope

- **正则 / 字段限定语法**（`title:foo`、`mode:project`）：facet UI 已经覆盖 mode 过滤。复杂 query 等真有用户需求再加。
- **搜索历史 / saved search**：低优。
- **全文搜索 UI 在 Canvas 内嵌**：modal 已经足够。Canvas 上叠浮窗反而拥挤。
- **流式期间的实时索引**：等 finalize。
- **mobile 触屏入口**：⌘P 无 fallback。Stage 17+ 桌面优先节奏不变。可以后续在 Header 加个 🔍 按钮触发同款 modal。
- **跨 trellis 实例的远端索引**：单人单机定位，不做。
- **删 session 后异步清理**：手工 DELETE 已包含。

### 开放问题

1. **trigram query 中含特殊字符**：用户搜 `"a/b"`、`"foo(bar)"` 这种带 FTS5 操作符的字符串会语法错。**预先 escape：把整个 query 用双引号包裹 + 内部双引号 → 两个双引号**（FTS5 双重引号转义）。
2. **重命名 session 后 sessionTitle 命中**：sessionTitle 不进 FTS，但搜索结果展示用的是 session.title 实时值（JOIN 拿到的）。重命名后立即生效，没问题。
3. **回填中断**：transaction 包裹，crash 即 rollback；下次启动 indexed.n 仍 = 0 重新回填，幂等。

### 验收

- 新装用户开 trellis → 索引为空 → 跑回填（几十毫秒可见）→ ⌘P 能搜出第一条数据
- 搜「图片输入」（4 字符） → 命中 Session 22 的 vision 笔记 + question + response
- 搜「tok」（3 字符英文） → 命中所有提到 tokenize / token / tokenizer 的节点
- 搜「图」（1 字符） → 提示「至少输入 3 个字符」，不发请求
- 删一个 session → 再搜该 session 内的关键词 → 0 结果
- 删一个有大量 response 的 node → 再搜原 response 内容 → 仅命中残留兄弟节点
- 切 facet「Workspace」→ 列表只剩 mode=workspace 的 session
- 点搜索结果 → 跳到目标 session + active 节点 + 全屏 + 匹配段 emerald pulse
- snippet 含 ellipsis → 跳成功但不 pulse（退化），不崩
