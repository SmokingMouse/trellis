#!/usr/bin/env bash
set -euo pipefail

port="${1:-}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "usage: verify-sessions.sh <port>" >&2
  exit 2
fi

env_file="${HOME}/.trellis-tenancy/env/fjtest.env"
if [[ ! -f "$env_file" ]]; then
  echo "missing env-file: $env_file" >&2
  exit 1
fi

pass=""
while IFS='=' read -r key value; do
  if [[ "$key" == "TRELLIS_AUTH_PASS" ]]; then pass="$value"; fi
done < "$env_file"
if [[ -z "$pass" ]]; then
  echo "TRELLIS_AUTH_PASS missing from $env_file" >&2
  exit 1
fi

base="http://127.0.0.1:${port}"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  if health="$(curl -fsS --max-time 2 "$base/__gate/health" 2>/dev/null)" \
    && grep -q '"next":"ready"' <<<"$health"; then
    break
  fi
  sleep 1
done
if (( SECONDS >= deadline )); then
  echo "trellis did not become ready: ${health:-no response}" >&2
  exit 1
fi

cookie_file="${TMPDIR:-/tmp}/trellis-verify-sessions-$$.cookies"
trap 'rm -f -- "$cookie_file"' EXIT
login="$(curl -fsS --max-time 10 -c "$cookie_file" \
  -H 'content-type: application/json' \
  --data "{\"password\":\"${pass}\"}" \
  "$base/api/login")" || {
    echo "login failed" >&2
    exit 1
  }
if ! grep -q '"ok":true' <<<"$login"; then
  echo "unexpected login response: $login" >&2
  exit 1
fi

sessions="$(curl -fsS --max-time 15 -b "$cookie_file" "$base/api/sessions")" || {
  echo "sessions request failed" >&2
  exit 1
}
if ! grep -q '"sessions":\[{' <<<"$sessions"; then
  echo "no persisted session found: $sessions" >&2
  exit 1
fi

echo SESSIONS_PERSIST
