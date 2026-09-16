#!/bin/bash
# Isolated daemon + probe run. $1 = scenario, $2 = repo root (defaults to review worktree)
set -u
SCN="${1:-A}"
ROOT="${2:?repo root (worktree with built dist) required}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE=/tmp/cxint-probe/run-$SCN-$(date +%H%M%S)
mkdir -p "$BASE/state/sm-toolkit/agent-server" "$BASE/work"
printf 'allowed_roots = ["%s"]\n' "$BASE/work" > "$BASE/state/sm-toolkit/agent-server/config.toml"
export XDG_STATE_HOME="$BASE/state"
export AGENT_SERVER_SOCKET_PATH="$BASE/as.sock"
"$ROOT/packages/agent-server/bin/agent-server" run --grace-ms 500 > "$BASE/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 60); do [ -S "$BASE/as.sock" ] && break; sleep 0.25; done
echo "daemon pid=$DPID socket=$BASE/as.sock root=$ROOT"
PROBE_SOCKET="$BASE/as.sock" PROBE_TOKEN="$BASE/state/sm-toolkit/agent-server/token" \
PROBE_CWD="$BASE/work" PROBE_LOG="$BASE/events.jsonl" \
PROBE_ROOT="$ROOT" \
  bun run "$HERE/driver.ts" "$SCN"
RC=$?
echo "probe exit=$RC"
kill -TERM $DPID 2>/dev/null; sleep 1.5; kill -KILL $DPID 2>/dev/null
echo "BASE=$BASE"
# 判定：interrupt 后 10 秒与 close 后都不得残留 sleep 600；driver 本身异常也算失败
LEAK=$(python3 - "$BASE/events.jsonl" <<'PY'
import json,sys
tags={}
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except Exception: continue
    tags[d.get("tag")]=d.get("data")
missing=[t for t in ("pgrep@10s","pgrep@after-close") if t not in tags]
if missing: print("missing:"+",".join(missing)); sys.exit(0)
leak=[t for t in ("pgrep@10s","pgrep@after-close") if (tags[t] or {}).get("out")]
print("leak:"+",".join(leak) if leak else "clean")
PY
)
echo "verdict=$LEAK"
pkill -fx "sleep 600" 2>/dev/null
[ "$RC" = 0 ] && [ "$LEAK" = clean ]
