---
id: 97b29d691523
commit: 
branch: worktree/silver-river-7607
timestamp: 2026-08-23T14:57:14+08:00
commit_message: ""
files_modified: ["app/api/chat/route.ts", "components/TurnStatsMeta.tsx", "lib/format-tokens.test.ts", "lib/server/cli-fork.ts", "lib/server/cli-jsonl.ts", "progress/archive.md", "scripts/test-cli-jsonl.ts"]
---

## Prompt

对 herdr 进行深度探查，使用 write craft 写一篇技术文章，帮…

看看这棵树,好像反应了 trellis 的某些 bug, 为啥分支会接续另一条分支的逻辑

## Summary

这棵树所反映的问题，是一个典型的 **「分支降级策略假定错误」+「Turn UUID 回填失败」** 共同导致的**上下文跨分支串染（Cross-Branch Context Bleed）Bug**。

---

### 一、 现象与真实调用链还原

以你在数据库（`~/.trellis/data.db` 会话 `90061380-bb0e-423e-a49b-208b45d7d352`）中的实际运行链路为例：

1. **根节点（Node `8bcb2658`）**：
   - 提问："对 herdr 进行深度探查，使用 write craft 写一篇技术文章..."
   - 底层关联了 Claude CLI 物理文件：`~/.claude/projects/.../8e60b806-f860-4c3d-a8b1-903ed7440a07.jsonl`。
2. **分支 1（主线连续对话）**：
   - `8bcb2658` $\to$ `96658104` $\to$ `b3bb0b2a` $\to$ `a7d83071` $\to$ `7cdad4f8` $\to$ `3793a575` $\to$ `c8bc12bb`
   - 该分支连续讨论了 herdr 源码、架构、SVG 流程图设计、飞书白板 Schema。
   - 所有对话顺次追加写入了 `8e60b806-....jsonl`（记录到了 Turn 8："画 svg 有用技能吗"）。
3. **分支 2（从根节点点击分叉，Node `4e4e5582`）**：
   - 用户预期：从根节点开新分支，完全不受分支 1（SVG/飞书白板等）的影响。
   - **实际发生**：Node `4e4e5582` 回答时不仅知道分支 1 讨论过的 SVG 与飞书白板，甚至直接在回答中延续了分支 1 的逻辑。
   - **JSONL 真实落盘**：Node `4e4e5582` 被作为 **Turn 9** 直接追加在 Turn 8（分支 1 的末端）之后！

---

### 二、 核心根因剖析

#### 致命缺陷 1：分支降级策略的错误假设（Fatal Fallback Flaw）

查看 `app/api/chat/route.ts`（第 605~624 行）关于 Project 模式分支（`body.kind === "branch"`）的处理：

```typescript
if (body.kind === "branch") {
  const lin = nativeLineageForNode(body.parentNodeId, spawnCwd);
  if (!lin) {
    claudeSessionId = null;
  } else if (lin.isJsonlTip && !hasOtherChild(body.parentNodeId, nodeId)) {
    // 只有当父节点是文件最末尾且没有其他子节点时，线性续聊才是安全的
    claudeSessionId = lin.lineageSid;
  } else if (lin.nodeTurnUuid) {
    // 正确路径：截取 root -> 父节点的 JSONL 前缀，生成全新的 newSid.jsonl
    const built = buildPrefixJsonlCore(lin.jsonlPath, lin.nodeTurnUuid);
    if (built) {
      setNodeResumeId(nodeId, family, built.newSid);
      claudeSessionId = built.newSid;
    } else {
      // ❌ 致命 Bug：切片构造失败时，降级回退到原 session
      claudeSessionId = lin.lineageSid;
    }
  } else {
    // ❌ 致命 Bug：缺少 nodeTurnUuid 时，降级回退到原 session
    claudeSessionId = lin.lineageSid;
  }
}
```

代码中的注释与开发假定曾认为：*“缺失只是降级线性，上下文只多不少，后者严格更安全”*。
**但这在分支场景下是完全错误的：**

- `claude --resume <sid>` 是 CLI 黑盒命令，**它没有“恢复到指定历史轮次”的参数，永远只会从该 JSONL 文件的最末尾（Tip）继续追加**。
- 当从根节点或历史节点分叉时，原会话文件的末端已经包含了分支 1

