#!/bin/sh
set -e
FJW="/Users/smokingmouse/.herdr/worktrees/焚决/feat-agent-tui-runner"
SMTK=/Users/smokingmouse/.herdr/worktrees/sm-toolkit/feat-dogfood
cd "$FJW" && bun test >/dev/null 2>&1
cd "$SMTK" && bun run typecheck >/dev/null 2>&1
cd "$SMTK/packages/agent-server" && bun test >/dev/null 2>&1
cd "$SMTK/apps/agent-tui" && bun test >/dev/null 2>&1
f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-dogfood-fix-*/out/result.md 2>/dev/null | head -1); test -s "$f"
cmp -s ~/.claude/skills/herdr-leader/scripts/fj.js /tmp/fj.js.baseline-dogfood
