#!/bin/bash
# trellis 更新脚本 —— 本地 + BOE 一键更新
# 用法: bash scripts/update-trellis.sh [local|boe|all]
set -euo pipefail

TARGET="${1:-all}"
PROXY="http://sys-proxy-rd-relay.byted.org:8118"
BOE_HOST="boe"
BOE_HOME="/data00/home/zhangpeng.pada"
BOE_SDK="$BOE_HOME/ai-coding/sm-toolkit"

log() { echo "=== $* ==="; }

update_local() {
  log "本地: 拉取 + 安装 + 构建 + 重启"
  cd ~/python/learning/trellis

  # 拉取
  git fetch origin
  git pull --ff-only

  # SDK 同步
  cd ~/sdk && git pull --ff-only 2>/dev/null || true
  cd ~/sdk/packages/agent && bunx tsc --build 2>&1 || true
  cd ~/sdk/packages/llm && bunx tsc --build 2>&1 || true

  # 安装 + 构建
  cd ~/python/learning/trellis
  make setup SDK_REPO=https://github.com/SmokingMouse/sm-toolkit.git 2>&1 | tail -5
  make build 2>&1 | tail -3

  # .env.local 检查（重新克隆后会丢失）
  if [ ! -f .env.local ]; then
    log "警告: .env.local 不存在，认证闸未开启"
  fi

  # 重启
  launchctl kickstart -k gui/$(id -u)/com.smokingmouse.trellis 2>&1 || true
  sleep 6

  # 验证
  local CODE
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://localhost:3088/ 2>&1 || true)
  log "本地 HTTP: $CODE (307=认证闸正常, 200=无认证闸)"
}

update_boe() {
  log "BOE: 拉取 + 安装 + 构建 + 重启"
  ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=no "$BOE_HOST" "
    export HOME=$BOE_HOME
    export PATH=\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
    export https_proxy=$PROXY
    export http_proxy=$PROXY

    # SDK 更新
    cd $BOE_SDK
    git stash 2>/dev/null || true
    git pull --ff-only 2>&1 | tail -3
    bun install 2>&1 | tail -3
    cd packages/llm && bun x tsc --build 2>&1
    cd ../agent && bun x tsc --build 2>&1

    # trellis 更新
    cd \$HOME/trellis
    git stash 2>/dev/null || true
    git pull --ff-only 2>&1 | tail -3
    make setup SDK_HOME=$BOE_SDK SDK_REPO=https://github.com/SmokingMouse/sm-toolkit.git 2>&1 | tail -5
    HOME=\$HOME bun --bun run build 2>&1 | tail -3

    # 杀掉可能卡住的 Next.js 子进程（3187 端口）
    pkill -9 -f 'next start -p 3187' 2>/dev/null || true
    sleep 2

    # 重启服务
    HOME=\$HOME systemctl --user restart trellis 2>&1
    sleep 12

    # 验证
    echo '=== BOE 验证 ==='
    ss -tlnp 2>/dev/null | grep -E '3088|3187'
    curl -s -o /dev/null -w 'BOE HTTP: %{http_code}\n' --connect-timeout 5 http://localhost:3088/ 2>&1
  "
}

case "$TARGET" in
  local) update_local ;;
  boe) update_boe ;;
  all) update_local; update_boe ;;
  *) echo "用法: $0 [local|boe|all]"; exit 1 ;;
esac

log "完成"
