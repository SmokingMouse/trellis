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
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:${TRELLIS_HOOK_PORT}/api/hooks/claude" \
  --noproxy '*' \
  --connect-timeout 0.5 --max-time 1.5 \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Trellis-Hook-Token: ${TRELLIS_HOOK_TOKEN}" \
  --data-urlencode "paneKey=${TRELLIS_PANE_KEY}" \
  --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
