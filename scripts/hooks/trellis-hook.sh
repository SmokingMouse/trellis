#!/bin/sh
# Trellis 的 Claude Code hook 发射端（对标 ~/.orca/agent-hooks/claude-hook.sh）。
#
# 契约：从 stdin 读 Claude Code 的 hook JSON，POST 给本机 Trellis；任何失败
# 都吞掉、永远 exit 0 —— 这个脚本挂在 Claude Code 的每一次工具调用前后，
# 它慢一秒 Claude 就慢一秒，它非零退出 Claude 就会把错误喂给模型。
#
# 端点文件由 Trellis 启动时写（lib/server/agent-hooks/endpoint.ts）：
#   $HOME/.trellis/hooks/endpoint.env
#     TRELLIS_HOOK_PORT=3088
#     TRELLIS_HOOK_TOKEN=<随机>
# 缺文件 / 缺键 = Trellis 没在跑或已关 hooks（TRELLIS_HOOKS=off），静默退出。
#
# 两种模式：
#   不带参数   观测：1.5s 上报、无输出。全局 ~/.claude/settings.json 挂的就是这个，所有 claude 都跑。
#   --block    阻塞：只由 trellis 拉起的 claude 的 --settings 挂（PreToolUse(AskUserQuestion) +
#              PermissionRequest，见 lib/server/agent-hooks/blocking-settings.ts）。长轮询 Trellis
#              等作答，拿到就把 hook JSON 打到 stdout；连不上 / 超时 / 交给终端 → 无输出 exit 0，
#              TUI 照常弹框。
ENDPOINT_FILE="${TRELLIS_HOOK_ENDPOINT:-$HOME/.trellis/hooks/endpoint.env}"
if [ ! -r "$ENDPOINT_FILE" ]; then
  exit 0
fi
TRELLIS_HOOK_PORT=""
TRELLIS_HOOK_TOKEN=""
. "$ENDPOINT_FILE" 2>/dev/null || exit 0
if [ -z "$TRELLIS_HOOK_PORT" ] || [ -z "$TRELLIS_HOOK_TOKEN" ]; then
  exit 0
fi
payload=$(cat)
if [ -z "$payload" ]; then
  exit 0
fi

# ---- 阻塞模式 -------------------------------------------------------------
# 分段长轮询：每段让 server 最多挂 TRELLIS_HOOK_SEGMENT 秒（默认 25），段与段之间重新读
# 端点文件（trellis 重启后端口 / 口令以新文件为准）。
#   首段就连不上            → 立即放手（Trellis 没在跑，别让用户白等）
#   连上过、之后断了        → 每秒重连，最多 TRELLIS_HOOK_RESUME 秒（默认 120）；server 留交互 3 分钟
#   总共等满 TRELLIS_HOOK_WAIT_MAX 秒（默认 1800） → 放手
# 应答是纯文本：首行 pending / done / pass，done 的余下几行是要打到 stdout 的 JSON。
trellis_block() {
  seg="${TRELLIS_HOOK_SEGMENT:-25}"
  resume="${TRELLIS_HOOK_RESUME:-120}"
  start=$(date +%s)
  deadline=$((start + ${TRELLIS_HOOK_WAIT_MAX:-1800}))
  # 本进程的 attempt：重连时原样带上，server 据此认回同一个交互（PermissionRequest 不带 tool_use_id）。
  attempt="$$-${start}-$(od -An -N6 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  connected=0
  lost_at=0
  while :; do
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      return 0
    fi
    wait_s=$seg
    if [ $((deadline - now)) -lt "$wait_s" ]; then
      wait_s=$((deadline - now))
    fi
    # 首段不挂（wait=0）：server 建好交互立刻回 pending，脚本马上知道「连上了」——
    # 否则首段挂着时 trellis 重启，会被误判成「一开始就连不上」而直接放手。
    if [ "$connected" -eq 0 ]; then
      wait_s=0
    fi
    resp=$(printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${TRELLIS_HOOK_PORT}/api/hooks/claude/interaction" \
      --noproxy '*' \
      --connect-timeout 1 --max-time $((wait_s + 10)) \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -H "X-Trellis-Hook-Token: ${TRELLIS_HOOK_TOKEN}" \
      --data-urlencode "paneKey=${TRELLIS_PANE_KEY:-${HERDR_PANE_ID:-}}" \
      --data-urlencode "attempt=${attempt}" \
      --data-urlencode "wait=${wait_s}" \
      --data-urlencode "payload@-" \
      -w '\n%{http_code}' 2>/dev/null) || resp="000"
    code=$(printf '%s\n' "$resp" | tail -n 1)
    body=$(printf '%s\n' "$resp" | sed '$d')
    first=$(printf '%s\n' "$body" | head -n 1)
    if [ "$code" = "200" ]; then
      case "$first" in
        done)
          printf '%s\n' "$body" | sed '1d'
          return 0
          ;;
        pending)
          connected=1
          lost_at=0
          continue
          ;;
        *)
          # pass（不阻塞 / 交给终端 / 过期 / 撤销）或看不懂的应答：放手
          return 0
          ;;
      esac
    fi
    # 非 200：没连上过就立即放手；连上过就进入重连窗口。
    if [ "$connected" -eq 0 ]; then
      return 0
    fi
    now=$(date +%s)
    if [ "$lost_at" -eq 0 ]; then
      lost_at=$now
    fi
    if [ $((now - lost_at)) -ge "$resume" ]; then
      return 0
    fi
    sleep 1
    TRELLIS_HOOK_PORT=""
    TRELLIS_HOOK_TOKEN=""
    . "$ENDPOINT_FILE" 2>/dev/null || true
  done
}

if [ "${1:-}" = "--block" ]; then
  trellis_block
  exit 0
fi

# ---- 观测模式（快路径，所有 claude 都跑这里） ------------------------------
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${TRELLIS_HOOK_PORT}/api/hooks/claude" \
  --noproxy '*' \
  --connect-timeout 0.5 --max-time 1.5 \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Trellis-Hook-Token: ${TRELLIS_HOOK_TOKEN}" \
  --data-urlencode "paneKey=${TRELLIS_PANE_KEY:-${HERDR_PANE_ID:-}}" \
  --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
