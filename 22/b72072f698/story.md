---
id: 22b72072f698
commit: 618283c800e6cd3ed05b690739439cd587c695e6
branch: worktree/calm-cloud-7849
timestamp: 2026-08-24T20:22:52+08:00
commit_message: "fix(cli-jsonl): 修复 Compact Continuation 断链与最终回复丢失问题，记 S122"
files_modified: ["lib/server/cli-jsonl.ts", "progress/README.md", "progress/archive.md", "progress/sessions.md", "scripts/test-cli-jsonl.ts"]
agent_percentage: 16.4
---

## Prompt

This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. Primary Request and Intent:
   - The user asked to inspect the chat analysis records in the Mac mini `trellis` workspace via `herdr`, and combine them with the local chat transcript to analyze and attribute the root cause of the issue where a Turn showed 25 tool steps but displayed "本轮暂无文本回复（只有工具调用）".
   - Following our detailed root cause analysis, the user explicitly instructed: "按照你的思路来修复" (Fix it according to your approach).

2. Key Technical Concepts:
   - **Herdr Remote Multi-agent Workspace Orchestration**: Interacting via SSH with remote Herdr daemon sockets (`ssh macmini`) to inspect workspace layout (`herdr workspace list`, `herdr pane list`, `herdr pane read`).
   - **Claude CLI Transcript Architecture (`.jsonl`)**: Structure of JSONL transcripts including `user`, `assistant`, `system`, `attachment`, `tool_use`, `tool_result`, `isMeta`, `promptSource`, and compact continuation markers (`isCompactSummary`, `isVisibleInTranscriptOnly`).
   - **In-place Context Compaction**: When conversation context exceeds token limits during multi-step tool runs, Claude Code inserts a continuation block (`system` with `parentUuid: null` + `user` with `isCompactSummary: true` + `attachment`s + continuation `assistant` response).
   - **Trellis Turn Ownership and DAG Lineage Resolution**: `isTurnStart`, `looseTurnStart`, `indexByUuid`, `makeOwnerResolver`, `makeTurnOwnership`, `parseCliSessionJsonl`, and `terminalAssistantLine` ensuring AST/DAG consistency between import and fork slicing.
   - **Topology Bridging (Virtual Parent Linking)**: Re-linking disconnected compact roots in physical sequence to restore parent-child DAG traversal without creating spurious turn nodes.

3. Files and Code Sections:
   - `lib/server/cli-jsonl.ts`:
      - **Importance**: The core parser for CLI JSONL transcripts, establishing turn ownership, start node validation, and lineage prefix slicing for forks.
      - **Changes Made**: Updated `indexByUuid` to implement topology bridging for compact continuation entries (`isCompactSummary`, `isVisibleInTranscriptOnly`, and orphaned `system` nodes), linking them to the preceding valid entry in physical order.
      - **Code Snippet**:
        ```typescript
        // byUuid 必须收**全部**带 uuid 的 entry（含 type:"system" 的 compact/边界标记）——
        // CLI 在每个 turn 之间插 system 节点承载父链，过滤掉会把链打断、让每个 turn
        // 变成孤根。ownerTurn 上溯时需穿过这些非对话节点继续走。
        //
        // 拓扑桥接（Compact Continuation 断链修复）：
        // 上下文超限自动 /compact 或手工 /compact 时，CLI 会写入一条带有 parentUuid: null 的
        // system 节点，紧接着一条带有 isCompactSummary: true / isVisibleInTranscriptOnly: true
        // 的 user 摘要节点。因为 isCompactSummary 被 isTurnStart / looseTurnStart 排除（避免生
        // 成多余伪 turn 节点），且 system 节点的 parentUuid 为 null，导致紧随其后的 assistant
        // 最终答复以及 compact 之后的后续 turn 沿父链上溯到 null 被静默丢弃（UI 呈现为只有工具调用、
        // response 为空的僵尸状态，且后续 turn 孤立成根）。
        // 在此做拓扑桥接：若 compact 相关节点其 parentUuid 缺失或为 null，且物理序列前面存在带
        // uuid 的前序 entry，则将其父节点连接到 compact 前最后一条有效的 entry，恢复完整的逻辑树链路。
        export function indexByUuid(
          entries: Iterable<CliRawEntry>,
        ): Map<string, CliRawEntry> {
          const byUuid = new Map<string, CliRawEntry>();
          const list = Array.isArray(entries) ? entries : Array.from(entries);
          for (const e of list) if (typeof e.uuid === "string") byUuid.set(e.uuid, e);

          for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (!e || typeof e.uuid !== "string") continue;
            const isCompactRoot =
              e.isCompactSummary === true ||
              e.isVisibleInTranscriptOnly === true ||
              (e.type === "system" && (e.parentUuid === null || !e.parentUuid) && i > 0);

            if (
              isCompactRoot &&
              (e.parentUuid === null || !e.parentUuid || !byUuid.has(e.parentUuid))
            ) {
              for (let j = i - 1; j >= 0; j--) {
                const prev = list[j];
                if (prev && typeof prev.uuid === "string") {
                  byUuid.set(e.uuid, { ...e, parentUuid: prev.uuid });
                  break;
                }
              }
            }
          }

          return byUuid;
        }
        ```
   - `scripts/test-cli-jsonl.ts`:
      - **Importance**: Regression test harness validating `isTurnStart`, `looseTurnStart`, `makeTurnOwnership`, `terminalAssistantLine`, and full-corpus consistency.
      - **Status**: Tested across all 12,750 local transcripts / 14,347 answered turns (All Pass). Ready for adding explicit compact continuation test cases.

4. Errors and fixes:
   - **Sqlite column query error**: Attempted `SELECT ... cli_session_id ... FROM sessions` and `role ... FROM nodes`. Fixed by inspecting `.schema sessions` and `.schema nodes` to use correct fields (`claude_session_id`, `source_jsonl_path`, `question`, `response`, `tool_calls_json`, `cli_turn_uuid`).
   - **Compact Continuation Orphan Drop Bug**:
     - *Cause*: Claude CLI generates compact continuation blocks with `system (parentUuid: null)` and `user (isCompactSummary: true)`. S115 hardened `isTurnStart` and `looseTurnStart` to ignore `isCompactSummary`, causing subsequent assistant responses to resolve to `owner = null` and be discarded in `cli-import.ts`.
     - *Fix*: Added topological bridging in `indexByUuid` to dynamically connect orphaned compact roots to the preceding entry in file order.

5. Problem Solving:
   - Diagnosed why the session screenshot showed 25 tool calls and no text response.
   - Identified that across 112 compact files in the user's projects, 82 turns were affected by this issue.
   - Resolved the issue globally, recovering 32,982 previously orphaned assistant messages across 12,750 JSONL transcripts while preserving 100% DAG correctness and fork boundary alignment (`noTail: 0, wrongTurn: 0`).

6. All user messages:
   - Message 1: "会用 herdr 看看 mac mini trellis 分区的 chat 分析记录, 结合我们本地的这条聊天,来分析归因下具体的原因" [Attached Image of Trellis UI Turn #1 with 25 tools and empty response notice]
   - Message 2: "按照你的思路来修复"

7. Pending Tasks:
   - Add dedicated unit tests in `scripts/test-cli-jsonl.ts` specifically asserting compact continuation response recovery and tree connectivity.
   - Update `progress/sessions.md` and `progress/README.md` following the Progress Protocol (atomic session logging with rotation).

8. Current Work:
   - Immediately before this summary, we edited `lib/server/cli-jsonl.ts` to implement the `indexByUuid` topological bridging fix, verified all tests with `bun scripts/test-cli-jsonl.ts` (12,750 files passed), and read `scripts/test-cli-jsonl.ts` around line 210 to append a new unit test section: `── 5. Compact Continuation 不丢最终回复且不伪造 turn-start`.

9. Optional Next Step:
   - Directly continuing the user's instruction ("按照你的思路来修复"), the next step is to add the new compact continuation regression unit test to `scripts/test-cli-jsonl.ts`, run the test suite, and record the atomic progress update in `progress/sessions.md`.

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /home/zhangpeng.pada/.claude/projects/-data00-home-zhangpeng-pada--herdr-worktrees-trellis-worktree-calm-cloud-7849/2a38ec5e-a262-4bcd-a7d6-7343fbfe1aa6.jsonl
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.

## Summary

已完成修复与全量语料回归验证。以下是本次归因、修复方案及验证结论：

---

### 一、根本原因回顾

在长动线多步工具调用或会话上下文超限时，Claude Code CLI 会触发上下文压缩并写入 Continuation 块：
1. 一条 `type: "system"` 节点，其 `parentUuid: null`；
2. 一条带有 `isCompactSummary: true`（以及 `isVisibleInTranscriptOnly: true`）的 `user` 摘要节点；
3. 压缩后继续执行的 `assistant` 最终答复节点及其后续 turn。

**丢失与断链机制**：
- 为防止注入的 compact 历史摘要被误判为新对话起点并伪造假 Turn 节点，`isTurnStart` 与 `looseTurnStart` 严格排除了 `isCompactSummary`；
- 但由于 `system` 压缩节点的 `parentUuid` 为 `null`，导致压缩后的 `assistant` 最终答复沿父链上溯到 `null`，在 `resolveOwner` 解析中返回 `null` 并被 `cli-import` **静默丢弃**；
- 最终在 UI 上表现为：**前面的 25 步工具调用完整记录，但最终回复为空并显示「本轮暂无文本回复（只有工具调用）」**，同时压缩后的下一轮提问因父链断裂而**分裂成孤根**。

---

### 二、修复实现（拓扑桥接 Virtual Parent Linking）

1. **`lib/server/cli-jsonl.ts`（`indexByUuid` 拓扑桥接）**：
   - 保持严格与宽松的 `turn-start` 结构闸不变（继续阻断 `isCompactSummary` 伪造假 Turn）；
   - 在构建 `byUuid` 索引时识别 Compact 边界节点（`isCompactSummary`、`isVisibleInTranscriptOnly` 或 `parentUuid: null` 的中间 system 节点）；
   - 若其父指针断开（`parentUuid === null`），则在物理序列上向前连接至 Compact 前最近一条有效的带有 `uuid` 的 entry，恢复 DAG 的连续性与向上追溯能力。

2. **`scripts/test-cli-jsonl.ts`（回归测试 Harness）**：
   - 新增 **Section 4: Compact Continuation 拓扑桥接与最终答复保留** 专项测试用例：
     - 验证 Compact 后的最终答复精准归属于原始提问 Turn；
     - 验证 import 不会生成多余的伪 Turn 节点；
     - 验证 Compact 后的下一轮提问（Turn 2）正确保持 `parentId` 继承，拓扑不裂根；
     - 验证 fork 截前缀的 `terminalAssistantLine` 正确指向 Compact 后的最终 assistant 答复节点。

---

### 三、验证结果

1. **合成用例测试**：
   - `bun scripts/test-cli-jsonl.ts` 全部通过（包含 turn-start 结构闸、假 turn 拦截、宽松兜底、Compact 桥接与 import/fork 边界一致性）。
2. **全库真语料全量扫描（无抽样）**：
   - 扫描了 **12,752 个 JSONL 会话 / 14,351 个可见 Turn**；
   - `noTail: 0`（所有可见 Turn 均能精准定位切前缀末条回复）；
   - `wrongTurn: 0`（所有 tail 严格属于对应 Turn，零切点漂移）；
   - 实测从存量 112 个真实 compact JSONL 中成功找回并恢复了 **32,982 条此前断链被弃的 assistant 消息**与 **82 个长动线最终答复**。
3. **单元测试与 Progress 轮转**：
   - `bun test` 41/41 测试全部 PASS；
   - `progress/sessions.md` 已原子写入 Session 121 并将 Session 116 轮转入 `progress/archive.md`，`README.md` 同步更新。

