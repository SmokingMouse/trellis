#!/bin/sh
d=$(ls -d /Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-doc-fix2-*/out 2>/dev/null | head -1)
f="$d/article.md"; test -s "$f" || exit 1
python3 -c "import sys,re;t=open(sys.argv[1]).read();n=len(re.findall(r'[一-鿿]',t));print('cjk',n);sys.exit(0 if 3000<=n<=5000 else 1)" "$f" || exit 1
grep -qE '^## 1\.' "$f" || exit 1
grep -q '```mermaid' "$f" || exit 1
grep -q '/Users/smokingmouse' "$f" && exit 1
grep -q 'WorktreeGroup.tsx' "$f" && exit 1
test -s "$d/overview.svg" && xmllint --noout "$d/overview.svg" || exit 1
test -s "$d/overview.png" && test -s "$d/changes.md" && test -s "$d/sources.md" && test -s "$d/verify.md"
