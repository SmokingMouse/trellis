#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
OUT=${AS_PROJECT_OUT:-$ROOT/out/mobile-as-project}
LOCK_DIR=/tmp/trellis-mobile-verify.lock
OWN_LOCK=0
H=
SERVER_PID=
DAEMON_PID=
REQUEST_PID=
SESSION=mv-as-project-$$
PORT=3478
BASE=http://127.0.0.1:$PORT
ab() { AGENT_BROWSER_SESSION="$SESSION" agent-browser "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  status=$?
  trap - 0 1 2 15
  if [ "$OWN_LOCK" = 1 ]; then
    if [ -n "$H" ] && [ -f "$H/trellis.db" ]; then sqlite3 "$H/trellis.db" 'SELECT node_id,resolved_json FROM as_turns' > "$OUT/resolutions.txt" 2>/dev/null || true; fi
    ab close >/dev/null 2>&1 || true
    for pid in "$REQUEST_PID" "$SERVER_PID" "$DAEMON_PID"; do [ -z "$pid" ] || kill "$pid" 2>/dev/null || true; done
    for pid in "$REQUEST_PID" "$SERVER_PID" "$DAEMON_PID"; do [ -z "$pid" ] || wait "$pid" 2>/dev/null || true; done
    if [ -n "$H" ]; then cp "$H"/*.log "$H"/*.json "$H"/*.sse "$OUT/" 2>/dev/null || true; rm -rf "$H"; fi
    rm -f "$LOCK_DIR/owner"; rmdir "$LOCK_DIR"
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15
for tool in bun agent-browser curl lsof sqlite3; do command -v "$tool" >/dev/null || fail "missing $tool"; done
tries=0
until mkdir "$LOCK_DIR" 2>/dev/null; do tries=$((tries+1)); [ "$tries" -lt 180 ] || fail 'lock timeout'; sleep 5; done
OWN_LOCK=1
echo "$$ mobile-as-project" > "$LOCK_DIR/owner"
mkdir -p "$OUT"
lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && fail "port $PORT in use"
H=$(mktemp -d /tmp/trellis-as-project-XXXXXX)
export no_proxy='*' http_proxy='' https_proxy='' ALL_PROXY=''
export TRELLIS_DB_PATH="$H/trellis.db" TRELLIS_LARK=off TRELLIS_AS=on TRELLIS_AS_PROJECT=on
export TRELLIS_AS_SOCKET="$H/as.sock" TRELLIS_AS_TOKEN_PATH="$H/.agent-server/token"
export TRELLIS_AUTH_PASS=as-project-pass TRELLIS_AUTH_TOKEN=as-project-token
wait_file() { tries=0; until [ -s "$1" ]; do tries=$((tries+1)); [ "$tries" -lt 90 ] || fail "missing $1"; sleep 1; done; }
wait_js() {
  label=$1; expression=$2; tries=0
  until ab eval "$expression" 2>/dev/null | grep -q '^true$'; do tries=$((tries+1)); if [ "$tries" -ge 60 ]; then ab snapshot || true; ab errors || true; ab console || true; fail "$label"; fi; sleep 1; done
  echo "PASS: $label"
}
post() { curl --noproxy '*' -fsS -b trellis_auth=as-project-token -H 'Content-Type: application/json' -d "$2" "$BASE$1"; }
db() { sqlite3 "$TRELLIS_DB_PATH" "$1"; }
echo '== build =='
bun --bun run build > "$H/build.log" 2>&1 || { tail -60 "$H/build.log"; fail build; }
HOME="$H" bun scripts/mobile-verify/as-project-fixture.ts "$H" > "$H/daemon.log" 2>&1 &
DAEMON_PID=$!
wait_file "$H/ready"
HOME="$H" bun --bun node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1 > "$H/server.log" 2>&1 &
SERVER_PID=$!
tries=0
until curl --noproxy '*' -fsS "$BASE/login" >/dev/null 2>&1; do tries=$((tries+1)); [ "$tries" -lt 90 ] || fail readiness; sleep 1; done
bun -e 'await Bun.write(process.argv[1],Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=","base64"))' "$H/pixel.png"
ATTACHMENT=$(curl --noproxy '*' -fsS -b trellis_auth=as-project-token -H 'Content-Type: image/png' --data-binary "@$H/pixel.png" "$BASE/api/uploads")
post /api/chat "{\"kind\":\"root\",\"question\":\"hold project\",\"mode\":\"project\",\"workspacePath\":\"$H\",\"provider\":\"mock\",\"permission\":\"plan\",\"effort\":\"high\",\"attachments\":[$ATTACHMENT]}" > "$H/first.sse" &
REQUEST_PID=$!
wait_file "$H/peer-attached"
SID=$(db 'SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1')
FIRST=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
[ "$(db "SELECT binding_type FROM sessions WHERE id='$SID'")" = thread ] || fail binding
ab set device 'iPhone 15'
ab set viewport 390 844
ab open "$BASE/login"
wait_js 'login ready' "Boolean(document.querySelector('#pw'))"
ab fill '#pw' as-project-pass
ab click 'button[type="submit"]'
ab open "$BASE/?session=$SID&node=$FIRST"
wait_js 'thread permission and system log visible' "Boolean(document.querySelector('[data-as-project=\"$FIRST\"] [data-as-system-log]')) && document.querySelector('[data-as-permission]')?.value === 'plan'"
wait_js 'live partial response visible' "document.body.innerText.includes('针对你问的') && document.querySelector('[data-as-system-log]')?.textContent.includes('project-proof')"
ab reload
wait_js 'refresh catchup preserves partial turn' "Boolean(document.querySelector('[data-as-project=\"$FIRST\"]')) && document.body.innerText.includes('针对你问的')"
curl --noproxy '*' -s --max-time 2 -b trellis_auth=as-project-token "$BASE/api/nodes/$FIRST/stream" > "$H/catchup.sse" || [ "$?" = 28 ]
PROOF_HOME="$H" PROOF_NODE="$FIRST" bun -e 'const {Database}=require("bun:sqlite");const db=new Database(process.env.TRELLIS_DB_PATH,{readonly:true});const n=db.query("SELECT response FROM nodes WHERE id=?").get(process.env.PROOF_NODE);const text=await Bun.file(process.env.PROOF_HOME+"/catchup.sse").text();const e=text.split("\n").filter(x=>x.startsWith("data: ")).map(x=>JSON.parse(x.slice(6))).find(e=>e.type==="catchup");if(!e||!e.response||e.response!==n.response)throw Error("catchup text differs from DB");db.close();console.log("PASS: catchup exactly matches persisted partial response")'
ab select '[data-as-permission]' default
wait_js 'permission/set applies' "document.querySelector('[data-as-permission]')?.value === 'default'"
BYPASS_CODE=$(curl --noproxy '*' -s -o "$H/bypass.json" -w '%{http_code}' -b trellis_auth=as-project-token -H 'Content-Type: application/json' -d '{"permission":"bypassPermissions"}' "$BASE/api/nodes/$FIRST/as")
[ "$BYPASS_CODE" = 409 ] || fail 'hot bypass must be refused'
ab screenshot "$OUT/mobile-as-project.png"
touch "$H/finish-first"
wait "$REQUEST_PID"; REQUEST_PID=
[ "$(db "SELECT status FROM nodes WHERE id='$FIRST'")" = done ] || fail 'first completion'
post /api/chat "{\"kind\":\"branch\",\"parentNodeId\":\"$FIRST\",\"question\":\"approval project\",\"provider\":\"mock\"}" > "$H/second.sse" &
REQUEST_PID=$!
tries=0
until [ "$(db 'SELECT COUNT(*) FROM nodes WHERE pending_interaction_json IS NOT NULL')" = 1 ]; do tries=$((tries+1)); [ "$tries" -lt 60 ] || fail approval; sleep 1; done
SECOND=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
ab open "$BASE/?session=$SID&node=$SECOND"
wait_js 'web approval card visible' "Boolean(document.querySelector('[data-mobile-interaction]'))"
touch "$H/approve-other"
wait_js 'other client decision withdraws card' "Boolean(document.querySelector('[data-as-resolved]')) && document.body.innerText.includes('已由 第二终端 处理') && !document.querySelector('[data-mobile-interaction]')"
wait "$REQUEST_PID"; REQUEST_PID=
post /api/chat "{\"kind\":\"branch\",\"parentNodeId\":\"$SECOND\",\"question\":\"compare project\",\"provider\":\"mock\"}" > "$H/third.sse"
THIRD=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
COUNTS_FILE="$H/counts.json" bun -e 'const c=await Bun.file(process.env.COUNTS_FILE).json(); if(c.spawns!==1||c.turns!==3) throw Error(JSON.stringify(c)); if(c.engines[0].options.effort!=="high"||c.engines[0].options.permission!=="plan")throw Error("run options lost");if(!c.engines[0].sent[0].input.some(i=>i.type==="image"&&i.mime==="image/png"&&i.path.startsWith("/")))throw Error("image attachment lost"); if(!c.peerEvents.some(e=>e.type==="delta"))throw Error("peer missed live stream"); console.log("PASS: three turns share one engine, image input, mapped run options and peer live stream")'
[ "$(db "SELECT COUNT(DISTINCT thread_id) FROM as_turns")" = 1 ] || fail 'thread reuse'
post /api/chat "{\"kind\":\"root\",\"question\":\"compare project\",\"mode\":\"chat\",\"provider\":\"mock\"}" > "$H/legacy.sse"
LEGACY=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
[ "$(db "SELECT response FROM nodes WHERE id='$THIRD'")" = "$(db "SELECT response FROM nodes WHERE id='$LEGACY'")" ] || fail 'DB response parity'
[ "$(db "SELECT token_output FROM nodes WHERE id='$THIRD'")" = "$(db "SELECT token_output FROM nodes WHERE id='$LEGACY'")" ] || fail 'DB usage parity'
echo 'PASS: DB projection matches legacy response and usage'
rm -f "$H/approve-other"
post /api/chat "{\"kind\":\"branch\",\"parentNodeId\":\"$THIRD\",\"question\":\"approval web\",\"provider\":\"mock\"}" > "$H/web-approval.sse" &
REQUEST_PID=$!
tries=0
until [ "$(db 'SELECT COUNT(*) FROM nodes WHERE pending_interaction_json IS NOT NULL')" = 1 ]; do tries=$((tries+1)); [ "$tries" -lt 60 ] || fail 'web approval'; sleep 1; done
FOURTH=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
ab open "$BASE/?session=$SID&node=$FOURTH"
wait_js 'web can answer approval' "Boolean(document.querySelector('[data-mobile-target=permission-allow]'))"
ab eval "document.querySelector('[data-mobile-target=permission-allow]').scrollIntoView({block:'center'}); true"
wait_js 'web approval button is reachable' "(() => { const el=document.querySelector('[data-mobile-target=permission-allow]');if(!el)return false;const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el; })()"
ab eval "(() => { const original=window.fetch;window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).includes('/respond'))sessionStorage.setItem('as-respond-status',String(r.status));return r;};return true; })()"
ab click '[data-mobile-target="permission-allow"]'
wait_js 'web approval acknowledged' "sessionStorage.getItem('as-respond-status') === '200'"
wait "$REQUEST_PID"; REQUEST_PID=
COUNTS_FILE="$H/counts.json" bun -e 'const c=await Bun.file(process.env.COUNTS_FILE).json(); if(!c.peerEvents.some(e=>e.type==="resolved"&&e.decidedBy.label==="Trellis 网页"))throw Error("peer missed web decision"); console.log("PASS: leased web approval resolves on second client")'
ORIGINAL_THREAD=$(db "SELECT thread_id FROM as_turns WHERE node_id='$FOURTH'")
post /api/chat "{\"kind\":\"branch\",\"parentNodeId\":\"$FOURTH\",\"fork\":true,\"question\":\"tip fork project\",\"provider\":\"mock\"}" > "$H/tip-fork.sse"
FORK_NODE=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
FORK_THREAD=$(db "SELECT thread_id FROM as_turns WHERE node_id='$FORK_NODE'")
[ -n "$FORK_THREAD" ] && [ "$FORK_THREAD" != "$ORIGINAL_THREAD" ] || fail 'tip fork must create a new thread binding'
[ "$(db "SELECT status FROM nodes WHERE id='$FORK_NODE'")" = done ] || fail 'tip fork completion'
[ "$(db "SELECT COUNT(*) FROM as_threads WHERE session_id='$SID'")" = 2 ] || fail 'fork session mapping'
echo 'PASS: latest-node fork succeeds with a new thread binding'
bun scripts/mobile-verify/as-project-fork-proof.ts "$FOURTH" "$FORK_NODE"
post /api/chat "{\"kind\":\"branch\",\"parentNodeId\":\"$FORK_NODE\",\"question\":\"interrupt project\",\"provider\":\"mock\"}" > "$H/interrupt.sse" &
REQUEST_PID=$!
sleep 2
INTERRUPT=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
post "/api/chat/$INTERRUPT/abort" '{}' > "$H/abort.json"
wait "$REQUEST_PID"; REQUEST_PID=
[ "$(db "SELECT status FROM nodes WHERE id='$INTERRUPT'")" = error ] || fail interrupt
echo 'PASS: turn/interrupt'
ab eval "(() => { const targets=[...document.querySelectorAll('[data-as-project] select,[data-as-project] summary')]; if(!targets.length)throw Error('no controls'); for(const el of targets){ const r=el.getBoundingClientRect();if(r.width<44||r.height<44)throw Error('small target'); } if(document.documentElement.scrollWidth>innerWidth)throw Error('overflow'); return true; })()"
echo 'PASS: mobile 44px targets and no horizontal overflow'
db "SELECT id,status,response FROM nodes WHERE session_id='$SID' ORDER BY id" > "$H/before-fork.txt"
FORK_CODE=$(curl --noproxy '*' -s -o "$H/fork.json" -w '%{http_code}' -b trellis_auth=as-project-token -H 'Content-Type: application/json' -d "{\"kind\":\"branch\",\"parentNodeId\":\"$FIRST\",\"fork\":true,\"question\":\"early fork project\",\"provider\":\"mock\"}" "$BASE/api/chat")
[ "$FORK_CODE" = 200 ] || fail "early-node fork must succeed (HTTP $FORK_CODE)"
grep -q '"type":"done"' "$H/fork.json" || fail 'early fork completion'
EARLY_FORK_NODE=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
db "SELECT id,status,response FROM nodes WHERE session_id='$SID' AND id!='$EARLY_FORK_NODE' ORDER BY id" > "$H/after-fork.txt"
cmp "$H/before-fork.txt" "$H/after-fork.txt" || fail 'early fork changed old nodes'
[ "$(db "SELECT COUNT(*) FROM as_threads WHERE session_id='$SID'")" = 3 ] || fail 'early fork thread mapping'
[ "$(db "SELECT thread_id FROM as_turns WHERE node_id='$FOURTH'")" = "$ORIGINAL_THREAD" ] || fail 'original binding changed'
bun scripts/mobile-verify/as-project-fork-proof.ts "$FIRST" "$EARLY_FORK_NODE"
ab open "$BASE/?session=$SID&node=$EARLY_FORK_NODE"
wait_js 'early-node fork controls visible' "Boolean(document.querySelector('[data-as-project=\"$EARLY_FORK_NODE\"]'))"
ab screenshot "$OUT/mobile-as-early-fork.png"
EARLY_CODE=$(curl --noproxy '*' -s -o "$H/early-question.sse" -w '%{http_code}' -b trellis_auth=as-project-token -H 'Content-Type: application/json' -d "{\"kind\":\"branch\",\"parentNodeId\":\"$FIRST\",\"question\":\"ordinary early question\",\"provider\":\"mock\"}" "$BASE/api/chat")
[ "$EARLY_CODE" = 200 ] || fail 'P1-1 ordinary early question must succeed'
EARLY_NODE=$(db 'SELECT id FROM nodes ORDER BY created_at DESC LIMIT 1')
[ "$(db "SELECT status FROM nodes WHERE id='$EARLY_NODE'")" = done ] || fail 'P1-1 ordinary early question left an error node'
[ "$(db "SELECT thread_id FROM as_turns WHERE node_id='$EARLY_NODE'")" != "$ORIGINAL_THREAD" ] || fail 'P1-1 early question reused later history'
grep -q '"type":"done"' "$H/early-question.sse" || fail 'P1-1 early question completion'
bun scripts/mobile-verify/as-project-fork-proof.ts "$FIRST" "$EARLY_NODE"
echo 'PASS: ordinary early continuation and explicit fork both return 200 with exact native history'
bun scripts/mobile-verify/as-project-regression.ts 'fork capability fallback'
RETRY_BEFORE=$(db "SELECT response FROM nodes WHERE id='$EARLY_NODE'")
RETRY_THREAD=$(db "SELECT thread_id FROM as_turns WHERE node_id='$EARLY_NODE'")
touch "$H/pause-retry"
post /api/chat "{\"kind\":\"retry\",\"nodeId\":\"$EARLY_NODE\",\"provider\":\"mock\"}" > "$H/retry.sse" &
REQUEST_PID=$!
sleep 2
[ "$(db "SELECT response FROM nodes WHERE id='$EARLY_NODE'")" = "$RETRY_BEFORE" ] || fail 'P0-1 retry cleared original answer before success'
rm "$H/pause-retry"
wait "$REQUEST_PID"; REQUEST_PID=
grep -q '"type":"done"' "$H/retry.sse" || fail 'P0-1 tip retry completion'
[ "$(db "SELECT thread_id FROM as_turns WHERE node_id='$EARLY_NODE'")" != "$RETRY_THREAD" ] || fail 'P0-1 tip retry fork'
db "SELECT response,status,tool_calls_json,token_input,token_output,final_start FROM nodes WHERE id='$EARLY_NODE'" > "$H/retry-before.txt"
touch "$H/fail-retry"
post /api/chat "{\"kind\":\"retry\",\"nodeId\":\"$EARLY_NODE\",\"provider\":\"mock\"}" > "$H/retry-failure.sse"
grep -q '"type":"error"' "$H/retry-failure.sse" || fail 'P0-1 retry error reported'
db "SELECT response,status,tool_calls_json,token_input,token_output,final_start FROM nodes WHERE id='$EARLY_NODE'" > "$H/retry-after.txt"
cmp "$H/retry-before.txt" "$H/retry-after.txt" || fail 'P0-1 failed retry changed original answer'
rm "$H/fail-retry"
post /api/chat "{\"kind\":\"retry\",\"nodeId\":\"$FIRST\",\"provider\":\"mock\"}" > "$H/retry-early.sse"
grep -q '"type":"done"' "$H/retry-early.sse" || fail 'P0-1 non-tip retry completion'
echo 'PASS: P0-1 tip and non-tip retries succeed; pending and failed retry preserve original answers'
kill "$DAEMON_PID"; wait "$DAEMON_PID" || true; DAEMON_PID=
post /api/chat "{\"kind\":\"root\",\"question\":\"fallback project\",\"mode\":\"project\",\"workspacePath\":\"$H\",\"provider\":\"mock\"}" > "$H/fallback.sse"
grep -q '"type":"notice"' "$H/fallback.sse" || fail 'fallback notice'
grep -q '"type":"done"' "$H/fallback.sse" || fail 'fallback completion'
echo 'PASS: daemon unavailable falls back to legacy run with notice'
ab close
kill "$SERVER_PID"; wait "$SERVER_PID" || true; SERVER_PID=
export TRELLIS_AS=off TRELLIS_AS_PROJECT=off
HOME="$H" bun --bun node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1 > "$H/server-hard-off.log" 2>&1 &
SERVER_PID=$!
tries=0
until curl --noproxy '*' -fsS "$BASE/login" >/dev/null 2>&1; do tries=$((tries+1)); [ "$tries" -lt 60 ] || fail 'hard-off readiness'; sleep 1; done
post /api/chat "{\"kind\":\"branch\",\"parentNodeId\":\"$FIRST\",\"question\":\"hard off preserved input\",\"provider\":\"mock\"}" > "$H/hard-off.sse"
grep -q '"type":"notice"' "$H/hard-off.sse" || fail 'P1-2 hard off notice'
grep -q '"type":"done"' "$H/hard-off.sse" || fail 'P1-2 hard off completion'
HARD_OFF_NODE=$(db "SELECT id FROM nodes WHERE question='hard off preserved input'")
[ "$(db "SELECT COUNT(*) FROM as_turns WHERE node_id='$HARD_OFF_NODE'")" = 0 ] || fail 'P1-2 hard off created AS turn'
echo 'PASS: P1-2 hard off falls back for an already bound session without losing input'
echo 'PASS: AS project verification including mid-thread fork and capability fallback'
