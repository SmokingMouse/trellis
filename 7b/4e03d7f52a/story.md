---
id: 7b4e03d7f52a
commit: b6e3063af3582bd097fda34e7ee74e3dc467bbbd
branch: worktree/silver-river-7607
timestamp: 2026-08-23T15:30:45+08:00
commit_message: "fix(cli-fork): 修复分叉串线与伪 turn 干扰，安全降级 fresh session，记 S115"
files_modified: ["app/api/chat/route.ts", "components/TurnStatsMeta.tsx", "lib/format-tokens.test.ts", "lib/server/cli-fork.ts", "lib/server/cli-jsonl.ts", "lib/tool-duration.ts", "progress/README.md", "progress/archive.md", "progress/sessions.md", "scripts/test-cli-jsonl.ts"]
agent_percentage: 0.0
---

## Prompt

This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

Summary:
1. Primary Request and Intent:
   - **User Request**: *"看看这棵树,好像反应了 trellis 的某些 bug, 为啥分支会接续另一条分支的逻辑"* followed by *"没问题,按照这个思路来改吧"*.
   - **Intent**: Diagnose and resolve the cross-branch context bleed bug in Trellis where branching from a root or historical node caused the new branch to append to and inherit the full transcript and execution context of a parallel branch instead of creating an isolated conversation branch from the selected node.

2. Key Technical Concepts:
   - **Lineage Isolation Model (`lineage_isolation=1`)**: In Trellis Project mode, each conversation branch corresponds to an isolated Claude CLI transcript file (`<sessionId>.jsonl`), with lineage head nodes holding their own `claude_session_id`.
   - **Prefix JSONL Slicing (`buildPrefixJsonlCore`)**: Branching from historical node $X$ trims the source transcript up to $Xs terminal assistant response, generates a new session UUID (`<newSid>.jsonl`), and resumes with `claude --resume <newSid>`.
   - **Turn Identification (`cli_turn_uuid`)**: Slicing requires the exact turn-start user entry UUID in the JSONL transcript, backfilled asynchronously after turn completion by `backfillNativeTurnUuid`.
   - **Safe Fresh Session Degradation**: `claude --resume <sid>` has no turn-slice flag and always resumes from the absolute tip of `<sid>.jsonl`. Falling back to `claudeSessionId = lin.lineageSid` on missing `nodeTurnUuid` or slice failure caused parallel branch pollution. The safe fallback is `claudeSessionId = null` (starting a fresh CLI session at the node with `sessionIdTarget = "node"`) and populating `history = buildHistoryForNode(nodeId, { maxDepth: foldDepth })` from Trellis DB.
   - **Compaction Summaries (`isCompactSummary`)**: Synthetically injected entries by Claude Code during `/compact`. They must be excluded from `looseTurnStart` to avoid masquerading as user conversation turns.

3. Files and Code Sections:
   - `lib/server/cli-jsonl.ts`:
     - *Significance*: Provides JSONL turn classification predicates (`isTurnStart`, `looseTurnStart`) and turn ownership resolution.
     - *Changes*: Excluded `isCompactSummary === true` and `isVisibleInTranscriptOnly === true` from `looseTurnStart`.
     - *Code Snippet*:
       ```typescript
       export function looseTurnStart(e: CliRawEntry): boolean {
         if (e.type !== "user") return false;
         if (isToolResultEntry(e)) return false;
         if (e.isCompactSummary === true) return false;
         if (e.isVisibleInTranscriptOnly === true) return false;
         return Boolean(userText(e)?.trim());
       }
       ```
   - `lib/server/cli-fork.ts`:
     - *Significance*: Handles native and attached lineage resolution, prefix slicing, and `cli_turn_uuid` backfilling.
     - *Changes*: Updated `backfillNativeTurnUuid` to iterate through `sortedTurns` (newest first) to find the turn matching `q` instead of only inspecting `[0]`.
     - *Code Snippet*:
       ```typescript
       export async function backfillNativeTurnUuid(nodeId: string): Promise<void> {
         const db = getDB();
         const row = db
           .prepare(
             `SELECT n.question, n.cli_turn_uuid, s.origin, s.context_mode AS mode,
                     s.workspace_path AS wp, s.lineage_isolation AS iso
              FROM nodes n JOIN sessions s ON s.id = n.session_id
              WHERE n.id = ?`,
           )
           .get(nodeId) as
           | {
               question: string;
               cli_turn_uuid: string | null;
               origin: string;
               mode: string;
               wp: string | null;
               iso: number;
             }
           | undefined;
         if (
           !row ||
           row.cli_turn_uuid !== null ||
           row.origin !== "native" ||
           row.mode !== "project" ||
           row.iso !== 1
         ) {
           return;
         }

         const q = row.question.trim();
         for (let i = 0; i < 8; i++) {
           const lin = nativeLineageForNode(nodeId, row.wp);
           if (lin) {
             const parsed = parseCliSessionJsonl(lin.jsonlPath);
             if (parsed && parsed.turns.length > 0) {
               const sortedTurns = [...parsed.turns].sort(
                 (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
               );
               const match = q
                 ? sortedTurns.find((t) => t.question.includes(q))
                 : sortedTurns[0];
               if (match) {
                 db.prepare(
                   "UPDATE nodes SET cli_turn_uuid = ? WHERE id = ? AND cli_turn_uuid IS NULL",
                 ).run(match.id, nodeId);
                 return;
               }
             }
           }
           await sleep(300);
         }
       }
       ```
   - `app/api/chat/route.ts`:
     - *Significance*: Main chat routing and run startup logic for attached, native, Claude, and Codex runs.
     - *Changes*: Replaced unsafe `claudeSessionId = lin.lineageSid` branch fallbacks with `claudeSessionId = null` and `history = buildHistoryForNode(nodeId, { maxDepth: foldDepth })`.
     - *Code Snippet* (Native Claude branch):
       ```typescript
       if (body.kind === "branch") {
         const lin = nativeLineageForNode(body.parentNodeId, spawnCwd);
         if (!lin) {
           claudeSessionId = null;
           if (history.length === 0) {
             history = buildHistoryForNode(nodeId, { maxDepth: foldDepth });
           }
         } else if (lin.isJsonlTip && !hasOtherChild(body.parentNodeId, nodeId)) {
           claudeSessionId = lin.lineageSid;
         } else if (lin.nodeTurnUuid) {
           const built = buildPrefixJsonlCore(lin.jsonlPath, lin.nodeTurnUuid);
           if (built) {
             setNodeResumeId(nodeId, family, built.newSid);
             claudeSessionId = built.newSid;
           } else {
             claudeSessionId = null;
             if (history.length === 0) {
               history = buildHistoryForNode(nodeId, { maxDepth: foldDepth });
             }
           }
         } else {
           claudeSessionId = null;
           if (history.length === 0) {
             history = buildHistoryForNode(nodeId, { maxDepth: foldDepth });
           }
         }
       }
       ```
   - `lib/tool-duration.ts` & `components/TurnStatsMeta.tsx` & `lib/format-tokens.test.ts`:
     - *Significance*: Separated non-JSX tool duration calculation logic (`computeToolActiveDuration`) into `lib/tool-duration.ts` so `bun test` runs without React JSX compiler runtime issues.
   - `scripts/test-cli-jsonl.ts`:
     - *Significance*: Regression harness for CLI JSONL parsing and fork boundary consistency.
     - *Changes*: Added test assertions for `looseTurnStart` rejecting compact summaries and transcript-only annotations.

4. Errors and fixes:
   - **Bug 1: Parallel Branch Bleed via Shared `lineageSid` Fallback**:
     - *Error*: When slicing failed or `nodeTurnUuid` was null, `route.ts` used `claudeSessionId = lin.lineageSid`, which resumed the tip of whatever branch ran last.
     - *Fix*: Set `claudeSessionId = null` and construct `history = buildHistoryForNode(nodeId, { maxDepth: foldDepth })`, registering a fresh isolated lineage head at the new node.
   - **Bug 2: Missing `cli_turn_uuid` Due to Compaction Summary Interference**:
     - *Error*: `looseTurnStart` parsed compact summaries as turns, and `backfillNativeTurnUuid` inspected only `sortedTurns[0]`, failing to find the user's turn question and timing out.
     - *Fix*: Filtered compact summaries in `looseTurnStart` and traversed `sortedTurns` to locate the turn containing `q`.
   - **JSX Runtime Error in `bun test`**:
     - *Error*: `lib/format-tokens.test.ts` imported `computeToolActiveDuration` directly from `components/TurnStatsMeta.tsx`, causing `bun test` to fail on missing `react/jsx-dev-runtime`.
     - *Fix*: Extracted `computeToolActiveDuration` into `lib/tool-duration.ts` and re-exported it from `TurnStatsMeta.tsx`.

5. Problem Solving:
   - Analyzed SQLite DB rows for node `8bcb2658` and session `90061380-...` and confirmed that node `8bcb2658` had `cli_turn_uuid = NULL`.
   - Tracked the JSONL file `8e60b806-....jsonl` to observe how a compaction summary entry (`f2442fe8-...`) blocked turn backfilling.
   - Verified that after fixing the turn predicate and fallback routing, branches created from historical nodes never pollute or inherit sibling branch transcripts.

6. All user messages:
   - *"对 herdr 进行深度探查，使用 write craft 写一篇技术文章，帮…\n\n看看这棵树,好像反应了 trellis 的某些 bug, 为啥分支会接续另一条分支的逻辑"*
   - *"没问题,按照这个思路来改吧"*

7. Pending Tasks:
   - Update `progress/sessions.md` (record Session 115 and rotate oldest entry into `progress/archive.md`) following the Progress Protocol.
   - Update `progress/README.md` Current Focus.
   - Commit changes and prepare for deployment.

8. Current Work:
   - All code edits across `lib/server/cli-jsonl.ts`, `lib/server/cli-fork.ts`, `app/api/chat/route.ts`, `lib/tool-duration.ts`, `components/TurnStatsMeta.tsx`, and `scripts/test-cli-jsonl.ts` are complete.
   - All tests (`bun test`, `bun scripts/test-cli-jsonl.ts`, `bun scripts/test-tool-tree.ts`, `tsc --noEmit`, and `eslint`) have passed with 0 errors.

9. Optional Next Step:
   - Update `progress/sessions.md` with Session 115 (Lineage 隔离分叉串线修复与紧凑摘要判据收紧), rotate Session 110 into `progress/archive.md`, update `progress/README.md`, and commit the changes.
   - User quote leading to this step: *"没问题,按照这个思路来改吧"*.

If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /home/zhangpeng.pada/.claude/projects/-data00-home-zhangpeng-pada--herdr-worktrees-trellis-worktree-silver-river-7607/28ff2aa8-30cd-40cd-a5f9-7989fd76adb8.jsonl
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.

## Summary

_not recorded_

