# Spec: 原生 Project 的 per-lineage 上下文隔离

> 分支 worktree：`orca`（progress 记录见 `blocks/orca.md`）。
> Reference：推翻 roadmap-2026q2「Project 跨节点 CLI 记忆 = 全树共享」的旧语义；
> 复用 decisions.md 2026-06-16「P2 简化：分叉统一构造前缀 jsonl」的引擎与路由。

## 问题

原生 Project 模式全树共用 root 的一个 claude session id（`getRootResumeIdForNode`），
每轮 `--resume` 线性 append。claude 侧是一份按时间混排所有分支的线性 transcript ——
**同 root 下平行分支彼此看得到对方说了什么**（README 里的 ⚠️ caveat）。树只在 trellis
侧分叉，上下文没分叉。

attached（cli-import）会话的 P2 已实现正确语义：**一条 lineage 一个 session id**，
线性续聊 append 同 jsonl，真分叉构造前缀 jsonl 成新 lineage。本 spec 把这套模型推广为
原生 Project 的默认语义。

## 目标语义

- **一条岔 = 一个 claude session（lineage）**；岔内续聊共享真历史（resume append），
  岔间完全隔离（分叉点截断）。
- Project 的「跨节点共享记忆」修正为「**沿祖先链共享记忆**」。
- native 与 attached 收敛到同一模型：一棵树 = 一组 lineage 按分叉点组合。

## 不变式（The invariants）

1. **lineage 头节点在自己行上持有 sid**（`nodes.claude_session_id`）：root 由
   session_init 写（target="node"），fork 节点由 trellis 生成 newSid 后 `setNodeResumeId`
   预写。线性子节点恒 NULL，靠 walk-up self-or-ancestor 解析归属。
2. **jsonl 纯 lineage**：新机制下一个 jsonl 只含一条链的轮次（分叉即另立 jsonl），
   `parentUuid` 链 = 祖先链。
3. **降级永远安全**：任何解析/构造失败 → 回退线性 resume 该 lineage（= 今日行为，
   上下文多不少错），绝不 fail 请求。

## 数据模型

- `sessions.lineage_isolation INTEGER NOT NULL DEFAULT 0`：1 = 本 session 走 per-lineage
  resume。**仅新建时对 `mode='project'` 置 1**；存量行恒 0 → 全程旧路径，零行为变化
  （存量 jsonl 是混排的，做不了可靠的 lineage 抽取，不迁移——见「存量」节）。
- `nodes.cli_turn_uuid TEXT`：该节点的 turn 在其 lineage jsonl 里的 **turn-start user
  entry uuid**（与 `ParsedTurn.id` 同义）。native isolated 节点 done 后回填；是
  `buildPrefixJsonl` 在该节点下刀的坐标。NULL = 回填缺失 → 分叉降级线性。

## 机制

### uuid 回填（`backfillNativeTurnUuid`，挂 run-bus done 钩子）

门禁：session `origin='native' && mode='project' && lineage_isolation=1`、claude family、
节点 `cli_turn_uuid IS NULL`。步骤：walk-up 解析 lineage sid → `claudeSessionPath(sid,
sessionCwd)` → `parseCliSessionJsonl` 取最新 turn →（防错配）该 turn 的 question 需
**包含**节点 question（project prompt 为原文或 anchor 包裹原文，contains 恒成立）→
UPDATE。轮询 ≤8×300ms（jsonl 落盘略滞后于 done，同 `reconcileAttachedTurn` 的时序）。
校验不过 → 放弃回填（错误的 uuid 比缺失更糟：分叉会切错位置；缺失只是降级线性）。

### 路由（`/api/chat`，仅 `native + project + claude + lineage_isolation=1`）

镜像 P2 的 attached 路由：

| kind | 解析 | resume | sessionIdTarget |
|---|---|---|---|
| root（新树/新话题） | — | fresh | `"node"`（lineage 头自持 sid） |
| branch，父是 lineage jsonl tip 且无其他子 | `nativeLineageForNode(parent)` | 线性 `--resume <lineageSid>` | undefined |
| branch，真分叉（非 tip / 已有子） | 同上 + 父的 `cli_turn_uuid` | `buildPrefixJsonlCore` → 预写 newSid → `--resume <newSid>` | undefined |
| branch，父 uuid 缺失 / 构造失败 | 同上 | 降级线性 resume | undefined |
| retry | `nativeLineageForNode(self)`（self-or-ancestor） | 该 lineage sid；无 → fresh | 无 sid 时 `"node"` |

tip 判定：`newestTurnId(jsonl) === 父.cli_turn_uuid`（attached 用节点 id 直比，native 经映射列）。

### 复用与零改

- `buildPrefixJsonl` 拆出核心 `buildPrefixJsonlCore(jsonlPath, turnUuid)`；attached
  包装函数行为不变。
- `hasOtherChild` / `setNodeResumeId` 直接复用。
- **不写 `cli_lineages`**：该表是 attach-sync 域（watcher 消费）；native 的 jsonl 路径由
  `claudeSessionPath(sid, cwd)` 确定性推导，无需登记。
- 删除清理零改：`deleteSession` / `deleteNodeSubtree` 本就收集子树内全部
  `claude_session_id` 并 unlink（origin 闸已存在）→ fork jsonl 随分支删除自动清理。
- 防回环零改：discover 的 `trellisOwnedSessionIds()` 查全部节点 sid → fork 新 sid
  自动被 attach 选择器排除。
- chat B-fork / workspace / codex / mock / attached 路径零改。

## 存量（legacy）

- 存量 project session：`lineage_isolation=0`，一切走 `getRootResumeIdForNode` 旧路径。
  不迁移：混排 jsonl 无每节点 uuid，按 created_at 对位（context-backfill 手法）做 resume
  身份太脆，错一位就接错上下文。
- 已知残留（继承自今日行为，非本改动引入）：删除线性子树不清 lineage jsonl 里对应轮次
  （turn 幽灵仍在上下文里）；aborted 轮的 token_context 回填对 fork lineage 不命中
  （best-effort 本性）。

## Non-goals（本期明确不做）

- **Chat B-fork 收编**：语义已正确（per-node 隔离），且 `--fork-session` 保 KV cache、
  零机器成本。是否为「减文件数 + 单一模型」收编，等本期稳定后按实际痛点另立决策。
- **codex per-lineage**：rollout jsonl 能否前缀构造未实测，挂在 codex parity P1 spike
  （见 dashboard Current Focus），本期路由门禁 `family==='claude'`。
- **Workspace 模式合并**：本改动落地后 Workspace 与 Project 的差异仅剩「有损折叠窗口
  vs 真历史 resume」（成本档位而非语义），预计走向合并，届时单独立决策（演化预期，
  非本期承诺）。
- worktree 文件系统隔离（分叉 × git worktree）：独立 feature，另立 spec。

## 验证清单

- [ ] `tsc --noEmit` + `make build`
- [ ] fixture（临时 DB + 手造纯 lineage jsonl）：walk-up 解析 / tip 判定 / 前缀构造
      截断正确 / 降级路径（uuid 缺失 → 线性）
- [ ] 真 claude e2e（隔离 dev server + 快照 DB）：isolated project 2 轮（暗号A→暗号B）
      → 从 turn1 分叉 → 分支只知暗号A；分叉后原链续聊不见分支内容（反向隔离）
- [ ] legacy 回归：flag=0 会话续聊/分叉行为与改动前一致（仍共享 root sid）
