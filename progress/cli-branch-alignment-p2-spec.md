# P2 实现契约：trellis→CLI 分叉（attached 会话）

> 承接 P1（[cli-branch-alignment-p1-spec.md](cli-branch-alignment-p1-spec.md) 已落地+验收）。母设计 = [cli-branch-alignment.md](cli-branch-alignment.md) §4/§5/§7。
> **只动 `origin='cli-import'` 链路**，原生 chat/workspace/project 零改动。

## 0. 结果

trellis 在 attached 会话里从**任意节点**继续提问，CLI 侧能正确反映：
- 从某 lineage 的 jsonl **tip 线性续** → 追加到该 lineage 的 jsonl（现状对 root 已工作，P2 推广到任意 lineage tip）。
- 从**非 tip 历史节点 X 分叉**（或从已有子节点的节点再问）→ trellis **构造一个前缀 jsonl**（复制 root→X、复用 message uuid、改 sessionId）→ `claude --resume <newSid>` → 新 lineage，新轮落新 jsonl。done 后经现有 `reconcileAttachedTurn` + `importCliLineage` union 回树，新轮挂在 X 下、零重复。

## 1. 架构决策（**对母设计的简化，需记 decisions.md**）

母设计把分叉分两路：tip→`--fork-session`、非 tip→构造前缀 jsonl。**P2 统一成一条：所有 trellis 发起的分叉都走「构造前缀 jsonl」**（前缀到 tip = 退化覆盖 tip-fork）。理由：`--fork-session` 只能从 tip 分、且要从 `session_init` 捕获新 id（多一条异步路径）；构造前缀 jsonl 一条机制覆盖全部分叉点，newSid 由 trellis 自己生成（同步已知，无需捕获），更简单更可验证。代价：放弃 fork-session 的 KV cache 复用（首轮稍慢），可接受。chat B-fork 机制**不复用、不改**。

## 2. 翻盘性未知 & 已验支点

- **支点（母设计 §5 已实测）**：构造前缀 jsonl（复制 root→X 行、复用 uuid、改 sessionId、resume）→ claude 当成在 X 分叉的合法会话续。fork 复制 uuid 不变 → union-by-uuid 零重复。
- **本轮翻盘性未知（P2b 真 claude 闸验）**：trellis **程序化**构造的前缀 jsonl，claude `--resume` 能否真的续上（行选择 / 截断边界 / sessionId 改写是否完整正确）。母设计验的是手造文件；P2b 必须用 trellis 构造器产物跑一次真 claude 才算闭环。**Codex sandbox 跑不了真 claude，此闸由人工/主 agent 在真 CLI 前验。**

## 3. 数据模型变更（在 P1 的 `cli_lineages` 上扩）

- **放宽 P1 的「仅 root 节点设 `claude_session_id`」** → **每节点 `claude_session_id` = 该 turn 所属 lineage 的 sid**（共享祖先归 root lineage、fork 独有 turn 归 fork lineage）。安全性不变：`deleteSession` 对 `origin='cli-import'` 跳过 jsonl unlink（origin 闸），故非 root 节点带 sid 不引入删除 hazard。
- 分叉时往 `cli_lineages` 插新 fork 行（`claude_session_id=newSid`, `jsonl_path=新文件`, `fork_point_uuid=X 的 turn uuid`, `is_root=0`, `synced_uuid=NULL`）。

## 4. 分两个可验证增量

### P2a —— 地基（不依赖真 claude，fixture + build 全验）

**A. importCliLineage 设 per-node lineage sid**（`cli-import-db.ts`）
- union 时记每个 turn id 的「首引入 lineage」（遍历 parsedRows，优先 `is_root=1` 的 lineage 占有共享 turn；fork 独有 turn 归该 fork）。
- upsertNode 的 `claude_session_id` 列写该 turn 的 lineage sid（取代 P1 的 `t.id === rootNodeId ? sid : null`）。
- root 节点仍 = root lineage sid（与现状一致）。

**B. 新解析器 `attachedLineageForNode(nodeId)`**（`cli-import-db.ts` 或新 `cli-fork.ts`）→ `{ lineageSid, sourceJsonlPath, isJsonlTip } | null`
- 读 node.claude_session_id（per-A 每节点都有）；为空则沿 parent 上溯到最近有值的祖先。
- `sourceJsonlPath` = `cli_lineages` 里该 sid 的 jsonl_path。
- `isJsonlTip` = 该 node 的 turn 是其 lineage jsonl 解析出的 turns 里 createdAt 最大的那个（即该 jsonl 的 tip）。
- 非 attached（session.origin≠'cli-import'）→ 返回 null（调用方回退原生路径）。

**C. 前缀 jsonl 构造器 `buildPrefixJsonl(branchFromNodeId): { newSid, jsonlPath } | null`**（新 `lib/server/cli-fork.ts`）
- 解析 X 的源 lineage jsonl（B 给 sourceJsonlPath）。
- **行选择（message 级，原始顺序）**：
  1. 读原 jsonl 全部行（保留原始 JSON object）。
  2. 求 root→X 的 message uuid 链：定位 X turn 的**末条 message**（X turn 的 assistant 行里 parentUuid 链最深的那条；用解析器同款 ownerTurn 归属判定哪些 message 属于 X turn，取其中 timestamp 最大/链尾），从它沿 `parentUuid` 上溯到根，收集链上所有 uuid 进 `keepUuids`。
  3. 选中行 = **保留**：① 无 uuid 的会话级元数据行（`mode`/`permission-mode`/`file-history-snapshot`/`last-prompt`/`ai-title` 等，且其在文件中出现位置 ≤ X 末条行的位置）② uuid ∈ `keepUuids` 的行。按**原始文件顺序**输出，截断在 X 末条 message 行（其后全部丢弃）。
  4. **截断边界铁律**：tool_use（assistant）必须连同其配对 tool_result（下一条 user 行）一起保留——因为 X turn 的末条 assistant 在所有 tool_result 之后，沿链上溯天然把 tool_result（parentUuid 在链上）纳入，不会截在 tool_use 和 tool_result 之间。验证时务必断言无「孤儿 tool_use」。
- **改写 sessionId**：`newSid = crypto.randomUUID()`；每行若有 `sessionId` 字段则改成 newSid。**uuid / parentUuid 一律不动**（复用是支点）。
- 写 `<newSid>.jsonl` 到**源 jsonl 同目录**（同 encoded cwd → claude 能 resume）。
- 返回 `{ newSid, jsonlPath }`；X 不可解析/无源 → null。

**P2a 验收（fixture，临时 DB，复用 P1 的 `TRELLIS_DB_PATH` + `npx tsx --conditions=react-server`）**：
1. attach 一个含 fork 的 lineage 组（造 rootA 线性 + forkB 在 X 分叉）→ 断言 per-node claude_session_id：共享祖先节点 = rootA sid、forkB 独有节点 = forkB sid。
2. `attachedLineageForNode` 对各节点返回正确 lineageSid / isJsonlTip（tip 节点 true、中间节点 false）。
3. `buildPrefixJsonl(中间节点 Y)` → 读回产物断言：① 行集 = root→Y（Y 之后的行全无）② 每行 sessionId = newSid、uuid 不变 ③ 无孤儿 tool_use ④ 文件落在同目录 `<newSid>.jsonl`。
4. 把产物当新 jsonl 跑 `parseCliSessionJsonl` → turns 与 root→Y 一致、tip = Y。
5. 清理临时文件 + DB。
- `npm run build` ✓；回归门：P1 的 fixture 行为仍全绿（per-node sid 改动没破坏 union/detach）。

### P2b —— 接线 + 真 claude 端到端（**需真 claude，Codex 交代码、人工验闸**）

**D. /api/chat 续聊 resume 解析改造**（`app/api/chat/route.ts`，**仅当 session.origin==='cli-import'**；其余 mode 走原 `getRootResumeIdForNode`/`getParentResumeId` 不变）
- 取 branchFrom = parent 节点 X（kind=branch 的 parentNodeId）。`attachedLineageForNode(X)` 拿 lineage。
- **线性续**（`isJsonlTip` 且 X 在 trellis 无子节点）→ `claudeSessionId = X.lineageSid`，`forkSession=false`，append。
- **分叉**（非 tip，或 X 已有子节点）→ `buildPrefixJsonl(X)` → 插 `cli_lineages` fork 行 → **预先**把新 trellis 节点的 `claude_session_id` 设为 newSid → `claudeSessionId = newSid`，`forkSession=false`。
- `sessionIdTarget` 对 attached 两路都 = `undefined`（id 由 trellis 已知/已写，不靠 session_init 捕获）。

**E. reconcile**：已就绪——`reconcileAttachedTurn` 已对整组 `importCliLineage` 重导。分叉新轮在 `<newSid>.jsonl`，union 后挂 X 下（新轮 parentUuid 指向 X 末条 message，uuid 与 X turn 共享 → 收敛）。临时流式节点删除逻辑不变。**确认**：新轮 canonical 节点经 A 拿到 claude_session_id=newSid（fork lineage），后续从它再续聊解析正确。

**P2b 验收（真 claude，人工/主 agent 在真 CLI 前跑，Codex 只交代码 + 自检逻辑）**：
1. attach 一个真实 CLI 会话 → 在 trellis 从**历史中间节点**分叉提问 → 观察：CLI 侧 `claude --resume <newSid>` 看得到该分叉、答案只基于 root→X 上下文（不含 X 之后）。
2. trellis 树正确长出分叉子树（reconcile 后无重复、挂在 X 下）。
3. 从分叉新轮再续一轮 → 落同一 newSid jsonl（线性），union 正确。
4. CLI 侧对该 attached 会话 `/branch`（P1 路径）与 trellis 分叉并存不打架。

## 5. Stop when / Pause if

- **P2a Stop when**：§P2a 验收 fixture 全过 + P1 回归绿 + build ✓。
- **Pause if**：
  - 行选择/截断需要改解析器 `cli-import.ts` 内核才能定位 X turn 边界 → 停（应只读解析结果，不改内核）。
  - per-node lineage sid 改动破坏 P1 union/detach 回归 → 停。
  - 需要改 `getRootResumeIdForNode` 或原生 chat/workspace/project 路径 → 停（边界判断错）。
  - 发现真实 jsonl 的 message 链结构与 §4.C 假设不符（如 X turn 末条 message 判定不了）→ 停，附样本。
