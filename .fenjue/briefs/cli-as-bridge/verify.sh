#!/usr/bin/env bash
# 硬验收：llm --as --print-launch 四种路线判定（由 fj settle 机械复跑）
# 用法: verify.sh <ok|down|tmp|fable> [worktree根]
set -u
CASE="${1:?case}"; W="${2:-/Users/smokingmouse/.herdr/worktrees/sm-toolkit/cli-as-bridge-impl}"
MAIN="$W/apps/cli/src/main.ts"
ERR=$(mktemp)
run() { perl -e "alarm shift; exec @ARGV" 90 "$@"; }   # 90 s 兜底，防交互进程挂住 settle
case "$CASE" in
  ok)   # 常驻 daemon 可用、cwd 在 HOME 下 → 走 AS，真建线程再关掉
    cd "$W" || exit 2
    out=$(run bun "$MAIN" sonnet --as --print-launch </dev/null 2>"$ERR"); rc=$?
    echo "$out"; cat "$ERR" >&2
    [ $rc -eq 0 ] && grep -q '"route":"as"' <<<"$out" && grep -q '"threadId":"th_' <<<"$out" ;;
  down) # endpoint 文件不存在 = daemon 不可用 → 回落本地，stderr 说明
    cd "$W" || exit 2
    out=$(SM_AS_ENDPOINT_JSON=/nonexistent/endpoint.json run bun "$MAIN" sonnet --as --print-launch </dev/null 2>"$ERR"); rc=$?
    echo "$out"; cat "$ERR" >&2
    [ $rc -eq 0 ] && grep -q '"route":"local"' <<<"$out" && grep -q 'agent-server' "$ERR" ;;
  tmp)  # cwd 不在 allowed_roots → 回落本地，原因含 allowed_roots
    cd /tmp || exit 2
    out=$(run bun "$MAIN" sonnet --as --print-launch </dev/null 2>"$ERR"); rc=$?
    echo "$out"; cat "$ERR" >&2
    [ $rc -eq 0 ] && grep -q '"route":"local"' <<<"$out" && grep -qi 'allowed_roots' "$ERR" ;;
  fable) # 策略拒绝（denied_models）→ 不回落、非零退出、stderr 含 denied
    cd "$W" || exit 2
    out=$(run bun "$MAIN" fable --as --print-launch </dev/null 2>"$ERR"); rc=$?
    echo "$out"; cat "$ERR" >&2
    [ $rc -ne 0 ] && grep -qi 'denied' "$ERR" ;;
  *) echo "unknown case $CASE" >&2; exit 2 ;;
esac
r=$?; rm -f "$ERR"; exit $r
