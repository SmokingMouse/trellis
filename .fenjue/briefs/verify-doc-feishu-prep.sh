#!/bin/sh
d=$(ls -d /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-doc-feishu-prep-*/out 2>/dev/null | head -1)
test -s "$d/feishu.xml" || exit 1
xmllint --noout "$d/feishu.xml" || exit 1
grep -q 'whiteboard type="mermaid"' "$d/feishu.xml" || exit 1
grep -q 'whiteboard type="svg"' "$d/feishu.xml" || exit 1
grep -q '/Users/smokingmouse' "$d/feishu.xml" && exit 1
test -s "$d/md2lark.ts" && test -s "$d/import-plan.md"
