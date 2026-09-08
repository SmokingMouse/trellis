#!/bin/sh
d=$(ls -d /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-doc-feishu-final-*/out 2>/dev/null | head -1)
test -s "$d/feishu.xml" && xmllint --noout "$d/feishu.xml" || exit 1
test -s "$d/payload.xml" || exit 1
grep -q 'whiteboard type="mermaid"' "$d/payload.xml" || exit 1
grep -q 'whiteboard type="svg"' "$d/payload.xml" || exit 1
grep -q '/Users/smokingmouse' "$d/payload.xml" && exit 1
test -s "$d/dry-run.json" && test -s "$d/preview.md"
