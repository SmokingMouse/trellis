# CLI ↔ trellis 分支对齐技术方案

> 目标：CLI 的 rewind/branch ↔ trellis 的分叉双向对齐，两侧实时同步。
> 状态：**设计完成、未实现**。承接 [cli-sync.md](cli-sync.md) 的 attached 双向同步。

## 开工指引（给下一个 session）

**先读这些，按顺序**：① 本文件全文（设计 + 实测地基）② [cli-sync.md](cli-sync.md)（attached
双向同步现状：解析器/importer/watcher/对账/SSE 都已落地，这次是在它上面扩分支）③ decisions.md
里 2026-06-16 的 CLI 同步几条。

**改动边界（爆炸半径）**：只动 `origin='cli-import'` 的 attached 会话（跑在 project 模式）。
原生 chat/workspace/project 零改动。判别开关是 `origin`、不是 `mode`。chat 的 B-fork 机制是
**复用**（调用，不改）。

**所有结论都有实测背书**（§0、§5），别再重新探查这些：
- fork-session 复制祖先 **uuid 不变**、对源无显式引用、血缘靠共享 uuid → union-by-uuid 是支点。
- `claude --resume <id>` 对 in-jsonl 多叶子**只走主/活跃链**，后追加的分叉看不到 → in-jsonl
  fork 不可靠 resume，必须 fork-session。
- 从任意历史节点分叉 = **构造前缀 jsonl**（复制 root→X、复用 uuid、改 sessionId）+ resume，已验。
- SDK `RunOptions` 只有 `resume`+`forkSession`，无 fork 父点选项 → 别指望 SDK 细粒度。

**P1 第一刀（最小、可独立验证）**：把 importer 从「一 jsonl 一 session」改成「一 lineage 组 union
进同一 session」。具体：
1. `cli-discover.ts` 加 lineage 发现：attach 时扫同目录所有 jsonl，按共享 uuid 把 fork 归到 root。
2. `cli-import-db.ts` importer：接受一组 jsonl，按 uuid upsert 进同一 trellis session（不再每个
   jsonl 一个 session）。新表 `cli_lineages`。
3. watcher 监听这组所有 jsonl + 新 fork 文件出现。
4. **验证**：CLI 里对一个 attached 会话跑 `/branch`（或 `--fork-session`）→ trellis 自动长出子树。
   （实测命令：见 §0 的 fork-session 实验。）

P2/P3 见 §6。**P1 跑通再上 P2**（trellis→CLI 分叉）。

## 0. 经验基础（全部实测，2026-06-16）

| 机制 | jsonl 表现 | `claude --resume <id>` 行为 | 能否独立 resume |
|---|---|---|---|
| **线性续聊** | 同 jsonl，parentUuid 线性追加 | 跟随主链，看得到 | —（就是本体） |
| **rewind / 编辑消息** | **同 jsonl 内** parentUuid 分叉（一个 parent 多 user 子） | **不可靠**：只走"活跃/主"叶子，后追加的分叉兄弟看不到（实测：手造更晚时间戳的 C 叶子被无视，resume 仍答 B） | ❌ 不单独可 resume |
| **`/branch` / `--fork-session`** | **新 jsonl（新 session id）**，复制祖先**且 uuid 完全相同**，分叉后新 uuid；对源**无显式引用**，血缘只能靠共享 uuid 推断 | 独立恢复，picker 自动分组挂在 root 下 | ✅ 独立可 resume |

**两条铁律（推翻了"in-jsonl 分叉能在 CLI 可见"的设想）：**
1. **可 resume 的分支 = fork-session（独立 session id）。** in-jsonl fork 只是同会话内"时光机"，CLI 不当它是可切换分支。
2. **fork 复制祖先 uuid 不变** → 按 uuid 去重，多个 jsonl 能自动并成一棵树、零重复。这是整个方案的支点。

## 1. 统一模型：一棵 trellis 树 = 一组 CLI session 的 uuid 并集

核心抽象：**节点 id = jsonl message uuid（全局唯一，跨 fork 共享）。** 一个 attached trellis
session 绑定 N 个 CLI session（1 个 root + 若干 fork）。把这 N 个 jsonl 的 parentUuid 图
**按 uuid 求并集** → 一棵树：

- 共享祖先（同 uuid）→ 自动合并成同一节点。
- in-jsonl 分叉（rewind/edit）→ 同一 parent 下的兄弟节点（解析器已支持）。
- fork-session → 在分叉点（最后一个共享 uuid）长出一条新 lineage 的子树。

```
root jsonl A:  n1 → n2 → n3 → n4(tip)
fork jsonl B:  n1 → n2 → n3 → n5 → n6      (n1-n3 与 A 同 uuid，n5 起分叉)
fork jsonl C:  n1 → n2 → n7                (n1-n2 同 uuid，n7 起分叉)

trellis 树(union by uuid):
        n1 → n2 → n3 → n4
                 │     └ (A tip)
                 │   → n5 → n6   (B)
                 └ → n7          (C)
```

## 2. 数据模型

- `sessions`：`origin='cli-attached'`，root_claude_session_id = 原会话 id。
- **新表 `cli_lineages(trellis_session_id, claude_session_id, fork_point_uuid, is_root)`**：一棵
  trellis 树绑定的所有 CLI session（root + forks）。fork_point_uuid = 该 fork 从哪个共享 uuid 分出。
- `nodes`：每节点 `claude_session_id` = 它所属 lineage（这轮是哪个 jsonl 写的）——决定续聊/分叉
  时 resume 哪个 session。
- 关键：节点 PK = jsonl uuid。**取消"一个 jsonl = 一个 trellis session"假设**，改为"一个
  lineage 组 = 一个 trellis session，多 jsonl union 进同一 session"。

## 3. CLI → trellis（导入 + 实时）

1. **Lineage 发现**：attach 一个会话时，扫同项目目录所有 jsonl，按**共享 uuid 前缀**把 fork
   jsonl 归到这个 root（B 的首个 uuid 出现在 A 里 → B 是 A 的 fork）。递归处理嵌套 fork。
2. **Union 导入**：把该 lineage 组所有 jsonl 解析 → 按 uuid upsert 进**同一个** trellis session。
   同 uuid 幂等合并，新 uuid 建节点，parentId 取并集图。
3. **实时**：watch 这些 jsonl 所在目录 +（新增）监听**新 fork jsonl 出现**（CLI 侧 `/branch`）→
   增量 union 重导 → 复用现有 `publishCliSessionUpdated` SSE → 前端 reload。
   - CLI rewind/edit → 原 jsonl 长出 in-jsonl 分叉 → 重导 → trellis 多一个兄弟节点。✓
   - CLI `/branch` → 新 fork jsonl → 发现 + union → trellis 长出新子树。✓

## 4. trellis → CLI（续聊 / 分叉 + 实时）

- **线性续聊（在 lineage tip）**：`claude --resume <node.claude_session_id>` → 写回同 jsonl。
  （现状已工作，实测过。）
- **分叉（显式 branch / 从非 tip 节点）**：`claude --resume <lineage> --fork-session` →
  新 session id（从 SessionStart 事件捕获，复用 chat B-fork 的 `sessionIdTarget:"node"` 机制）→
  落 `cli_lineages` 新行 + 新节点 claude_session_id = fork id。
  → CLI 端 `claude --resume <fork-id>` 看得到、picker 分组挂 root 下。✓
- **身份对账**：复用现有 `reconcileAttachedTurn`——done 后重导该 lineage jsonl，临时流式节点
  换成 canonical jsonl-uuid 节点。fork 因 uuid 复制不变，union 导入零重复。

## 5. 任意节点分叉：用「构造前缀 jsonl」解决（实测通过）

原以为是硬约束（`--fork-session` 只能从 tip 分），实测找到干净解法，**约束解除**。

- **排除的路**：agent-gateway SDK 的 `RunOptions` 只有 `resume` + `forkSession`(布尔)，**无**
  指定 fork 父点的选项——SDK 是 CLI flag 的薄封装，不能从任意 message fork。
- **采用的路（= 用户提的 Branch+Rewind 的数据层本质）**：要从任意历史节点 X 分叉，trellis
  **自己构造一个新 jsonl**：把"root→X 路径"的所有行复制过去（**复用原 message uuid、只改
  `sessionId` 字段为新 id**），砍掉 X 之后的行，然后 `claude --resume <new-id>` —— claude 把它
  当成在 X 分叉的合法会话，从 X 继续。
- **实测验证**：A 有 X→Y→Z 线性；构造只到 Y 的副本 → `claude --resume` 答 "Y=20"（知道 X/Y、
  不知 Z）→ **确实从任意节点 Y 分叉了，且独立可 resume**。
- **为什么 rewind 不可脚本化也没关系**：交互式 `/rewind` 无 CLI flag，但它的数据层效果 =「下一轮
  parentUuid 指向 X」=「一个到 X 为止的会话」——trellis 直接构造这个会话即可，不需要驱动交互。
- **和 union 模型天然兼容**：构造的副本祖先 uuid 不变 → union-by-uuid 自动和原树合并，新轮才是
  新 uuid 的新分支。零重复。
- **实现注意**：① 截断必须在干净的 turn 边界（含 X 的 user+assistant，砍其后全部；注意 tool 调用
  / compaction 边界别截在中间）② 复制全部行类型（system/mode/file-history-snapshot/attachment
  都带上，实测带上能 resume）③ 改写每行 `sessionId`。

## 5b. 仍需注意的边界

1. ~~fork 点限制~~ → 已由 §5 解决。
2. **picker 分组靠什么**：实测 fork jsonl 对源**无显式父字段**，Claude 怎么分组待确认（纯共享
   uuid 扫描？还是有别处索引）。影响 trellis 是否要主动维护分组展示。
3. **并发**：同一 lineage 别两端同时写（沿用 picker 提示 + 现有 live 感知可强化为"被 CLI 进程占用
   时禁 trellis 续聊"）。
4. **fork 爆炸**：每次 trellis 分叉造一个新 jsonl，重度使用会在项目目录堆很多 fork 文件——可接受
   （Claude 自己 /branch 也这样），但 watch 的目录文件数会涨。

## 6. 分阶段实施

- **P1：union 导入 + lineage 发现 + watch 扩展**（CLI→trellis 方向先全通）。
  产出：CLI 里 rewind/`/branch` 出来的分支，在 trellis 树里正确显示成分叉。验证：CLI 跑 `/branch`
  → trellis 自动长出子树。
- **P2：trellis 分叉 → 新可 resume session**（trellis→CLI 方向）。两种分叉：
  - **从 lineage tip 分** → 直接 `--fork-session`（复用 chat B-fork 机制）。
  - **从任意历史节点 X 分** → 构造前缀 jsonl（§5：复制 root→X、复用 uuid、改 sessionId）→
    `claude --resume <new-id>` 续。trellis 已有 import 的全部节点，构造材料现成。
  - 配合现有 `reconcileAttachedTurn` 对账。验证：trellis 任意节点分叉 → `claude --resume <id>`
    在 CLI 看得到、picker 分组。
- **P3：边界收尾**——fork 点限制的最终处理、picker 分组对齐、并发护栏强化、fork 文件管理。

## 7. 与现有实现的衔接

- 解析器 `cli-import.ts`：已按 uuid 当节点 id、已把 in-jsonl 分叉解析成兄弟——**P1 的 union 只需
  在 import 层把"一个 jsonl"扩成"一组 jsonl"**，解析内核不动。
- `cli-import-db.ts` importer：要从"一 jsonl 一 session"改成"一 lineage 组一 session"（union upsert）。
- chat B-fork（`sdk-adapter.ts` forkSession + run-bus `sessionIdTarget:"node"`）：**P2 直接复用**，
  attached 分叉走这条路而非 project 共享 resume。
- watcher / SSE / live 感知 / 对账：机制都在，P1/P2 扩展监听范围 + lineage 维度即可。
