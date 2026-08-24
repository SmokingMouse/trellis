---
id: 72e15d85e9c2
commit: 381e6b8ad77f796ee08058930fb81daeb1c6bc0f
branch: worktree/silver-river-7607
timestamp: 2026-08-24T11:36:21+08:00
commit_message: "Merge origin/main into worktree/silver-river-7607：本 session 顺延为 S120，progress 轮转 S115 入 archive"
files_modified: ["app/api/nodes/[id]/route.ts", "app/api/sessions/[id]/route.ts", "app/api/sessions/route.ts", "app/page.tsx", "components/Canvas.tsx", "components/Outline.tsx", "components/SessionSidebar.tsx", "components/SessionTabs.tsx", "components/TaskToast.tsx", "components/TreePanel.tsx", "components/TurnStatsMeta.tsx", "components/tools/ToolRow.tsx", "components/tools/ToolTimeline.tsx", "components/tools/views/WorkflowView.tsx", "lib/collapsed.test.ts", "lib/collapsed.ts", "lib/format-duration.ts", "lib/format-tokens.test.ts", "lib/format-tokens.ts", "lib/server/repo.ts", "lib/server/tasks.ts", "lib/tool-duration.ts", "lib/tool-tree.test.ts", "lib/tool-tree.ts", "lib/tree-panel.test.ts", "lib/types.ts", "progress/README.md", "progress/archive.md", "progress/sessions.md", "scripts/test-timeline-render.tsx", "skills/trellis-admin/SKILL.md", "skills/trellis-admin/scripts/trellisctl.ts", "stores/sessionStore.ts"]
agent_percentage: 0.0
---

## Prompt

提交 PR

## Summary

已完成根因分析与代码修复，并已记录在 `progress/sessions.md` (Session 115) 提交入库。

---

### 1. 根因复盘：分支为何会接续另一条平行分支？

在 Trellis 的 `project` 模式与原生 Lineage 隔离设计中，分支分叉依赖两套逻辑：
1. **JSONL 前缀切片 (`buildPrefixJsonlCore`)**：当用户在历史节点 $X$ 开辟新分支时，系统需要以 $X$ 的提问起始 Entry UUID（即 `cli_turn_uuid`）为界，截断父 Lineage JSONL 文件直到该轮的末条 Assistant 回复，生成独立的 `<newSid>.jsonl` 并通过 `claude --resume <newSid>` 启动隔离分支。
2. **Turn UUID 异步回填 (`backfillNativeTurnUuid`)**：在提问完成后，系统后台轮询解析 JSONL 文件，将用户提问在 JSONL 里的 UUID 回填到 `nodes.cli_turn_uuid`。

此前存在三个叠加缺陷导致了串线：
- **缺陷 ①（摘要伪条目干扰）**：Claude Code 在执行 `/compact` 或上下文压缩时，会注入 `isCompactSummary: true` 和 `isVisibleInTranscriptOnly: true` 的用户 Entry。`looseTurnStart` 原先未排除这两种条目，被解析器当成轮次起点。
- **缺陷 ②（最新轮匹配盲区）**：`backfillNativeTurnUuid` 此前仅比对 `sortedTurns[0]`。如果末尾有新的并行轮次或 compact 伪条目插入，导致 `sortedTurns[0].question` 不包含当前节点的提问，回填直接放弃，`cli_turn_uuid` 保持为 `NULL`。
- **缺陷 ③（回退逻辑串线致命伤）**：在 `app/api/chat/route.ts` 中，当 `nodeTurnUuid` 为 `NULL` 或前缀切片构造失败时，兜底分支写成了：
  ```typescript
  claudeSessionId = lin.lineageSid; // ❌ 错误地回退到了父会话的 lineageSid
  ```
  `claude --resume <lineageSid>` 无法按轮次切片，**永远只会接续该 JSONL 文件的绝对 tip（最末端）**。因此当有另一条平行分支在该 session 上继续跑过之后，新分支就会直接继承那条平行分支的最新全部上下文，造成严重的跨分支逻辑串线。

---

### 2. 修复方案

1. **严格收紧 `looseTurnStart` 判据 (`lib/server/cli-jsonl.ts`)**：
   - 明确过滤 `isCompactSummary === true` 与 `isVisibleInTranscriptOnly === true`，杜绝压缩合成条目干扰 turn 边界。
2. **强化 `backfillNativeTurnUuid` 鲁棒性 (`lib/server/cli-fork.ts`)**：
   - 遍历 `sortedTurns` 匹配节点的提问文本（`sortedTurns.find(t => t.question.includes(q))`），确保准确回填；若无法匹配则安全置空。
3. **彻底阻断串线回退，实行安全降级 (`app/api/chat/route.ts`)**：
   - 在 native project 模式（以及 attached 模式）下，若无 Lineage、切片失败或 `nodeTurnUuid` 缺失，**一律强制 `claudeSessionId = null`**，绝不再继承父 lineage 的 tip；
   - 同时通过 `history = buildHistoryForNode(nodeId, { maxDepth: foldDepth })` 将 Trellis DB 中精准的祖先树历史注入作为 prompt 上下文，并在该节点开启全新的独立 CLI Lineage。
4. **测试与运行时解耦 (`lib/tool-duration.ts`)**：
   - 提取工具执行耗时区间合并纯函数，避免 `bun test` 加载 JSX 运行时。

---

### 3. 验证结果

- **自动化单测与边界测试**：
  - `bun test`: 22 个测试用例全部通过（涵盖 Token 精

