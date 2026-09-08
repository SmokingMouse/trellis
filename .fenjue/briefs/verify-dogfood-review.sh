#!/bin/sh
f=$(ls /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-dogfood-review2-*/out/review.md 2>/dev/null | head -1)
test -n "$f" && grep -q '^结论' "$f" || exit 1
cmp -s ~/.claude/skills/herdr-leader/scripts/fj.js /tmp/fj.js.baseline-dogfood || exit 1
test ! -S ~/.sm-toolkit/agent-server.sock || exit 1
