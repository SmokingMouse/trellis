# Block: orca（worktree 分支 `orca`）

> 并行 worktree 独占进度块（规则见 `~/.claude/global/rules/parallel-worktree.md`）。
> merge 回 main 后把下方「待提炼」并入 README/decisions，然后删本文件。

## Current Focus

**原生 Project per-lineage 上下文隔离——已实现 + fixture/e2e 全过，待 commit/merge。**
→ [spec](../project-lineage-isolation-spec.md)

## Session Log

### Session 1 (2026-07-14)

- **缘起**：对照 onorca.dev（Orca ADE）找 trellis 启发 → 收敛到「分支 = 平行世界」
  的两半：上下文隔离（本次）+ worktree 文件系统隔离（另立，未做）。用户确认方向：
  per-lineage（attached P2 模型）定为唯一正确语义，推广到原生 Project。
- **Done（代码，全部在本 worktree，基 `1345c51`）**：
  - `sqlite.ts`：+`sessions.lineage_isolation`（新建 project=1，存量恒 0=旧行为）、
    +`nodes.cli_turn_uuid`（native 节点 ↔ jsonl turn-start uuid 映射）。
  - `repo.ts`：`claudeSessionPath` 导出 + **realpath 归一修复**（存量 bug：macOS
    `/tmp`→`/private/tmp` 等含 symlink 的 workspace 下，CLI 按 realpath 编码目录而
    trellis 按原样路径推导 → resume 验证恒 false → project 每轮静默丢历史；e2e 实测
    抓到并修复）；`createSessionWithRoot` 落 flag；+`isLineageIsolated`。
  - `cli-fork.ts`：`buildPrefixJsonl` 拆出 `buildPrefixJsonlCore(jsonlPath, turnUuid)`
    （attached 包装不变）；+`nativeLineageForNode`（self-or-ancestor sid walk-up +
    claudeSessionPath 推导 + tip 判定经 cli_turn_uuid）；+`backfillNativeTurnUuid`
    （done 后轮询 ≤8×300ms，防错配闸 = 最新 turn question 须包含节点 question，
    不过闸放弃回填→降级）；`cliResumeForNode` isolated 会话改走 lineage 解析。
  - `run-bus.ts`：done 钩子挂 backfill（动态 import，best-effort，与 reconcile 按
    origin 互斥）。
  - `app/api/chat/route.ts`：native isolated 路由（镜像 P2）：tip 且无其他子→线性
    resume；真分叉→前缀 jsonl + `setNodeResumeId` 预写新 lineage 头；uuid 缺失/构造
    失败→降级线性；root/新话题→fresh + `sessionIdTarget:"node"`（lineage 头自持）；
    retry→self-or-ancestor lineage。存量（flag=0）/codex/chat/workspace/attached 零改。
  - `README.md`：Project 模式语义更新，旧 ⚠️ 平行分支穿模 caveat 删除。
- **验证**：`tsc --noEmit` ✓ `make build` ✓；fixture（临时 DB + 手造 lineage jsonl，
  脚本已删）7 组断言 ALL PASS×2（realpath 修复前后各一遍）：walk-up/tip 判定/前缀
  截断（含旧 sid 无残留、uuid 保留）/回填/防错配/门禁/jsonl 缺失自愈；**真 claude e2e
  （隔离 `next start` :3007 + 临时 DB + haiku，产物全清）**：① 线性两轮 append 同
  jsonl、线性节点无自持 sid、uuid 均回填 ② 真分叉→fork 自持新 sid + 第 2 个 jsonl +
  回答「第二个暗号不存在」（前缀截断生效）③ 反向隔离：原链续聊只见两个暗号、fork 的
  樱桃不可见、原链 jsonl 未被污染 ④ legacy 回归：flag 拍 0 后分叉知道全部暗号（旧共享
  语义保留）、无 uuid 回填（门禁生效）。
- **Next**：① commit 本 worktree → merge main（注意主 checkout 有 Session 46 未
  commit 改动，文件面基本不相交：本次动 repo/cli-fork/run-bus/chat-route/sqlite，
  S46 动 providers/server/ModelPicker/commands）；② merge 后串行提炼下方条目。

## 待提炼（merge 后进共享文件）

- **decisions.md 追加**：「2026-07-14 · Project 语义改 per-lineage 隔离」——Decision:
  原生 Project 从全树共享 root sid 改为一条岔一个 session（推广 P2 引擎），存量不迁移
  （flag 闸）；Why: 树 UI 承诺分支平行而共享穿模，P2 已实测同款机制；Alternatives:
  ①保持共享（穿模，用户明确否决）②chat B-fork 每节点一 session（文件 O(N²) 且弃
  fork-session cache，仅 chat 保留）；Reference/取代: roadmap-2026q2「Project 跨节点
  记忆=全树共享」的旧语义、2026-06-16 P2「只动 cli-import」的范围决策（本次解除）。
- **Verified Fact 候选**：claude CLI 按 **realpath** 编码 transcript 目录
  （`/tmp/x` → `-private-tmp-x`），任何按原样路径推导 `~/.claude/projects/<encoded>`
  的代码在含 symlink 的 cwd 下都会错位（已在 claudeSessionPath 修复，e2e 实测钉死）。
- **README dashboard**：Current Focus 更新 + spec 链接；「Workspace 与 Project 差异
  仅剩记忆策略、预计合并」的演化预期（spec non-goals 已记）。
