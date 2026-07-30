# trellis bootstrap.
#
# The LLM/CLI-runtime layer (@smokingmouse/agent + @smokingmouse/llm) is a
# normal npm dependency now — `bun install` is the whole install story. The
# only remaining bun gotcha: `bun run dev/build/start` alone doesn't force
# Next/Turbopack's internally-spawned worker processes onto bun's own runtime,
# so `bun:sqlite` (a Bun-only built-in, used by lib/server/sqlite.ts) fails to
# resolve inside those workers. `bun --bun run ...` does force it — that's why
# dev/build/start below all use `--bun`, not plain `run`.
#
# Hacking on the SDK itself (repo: github.com/SmokingMouse/sm-toolkit, e.g.
# checked out at ~/sdk)? `make link-sdk` symlinks the two packages into
# node_modules via `bun link`. A later `bun install` wipes the links — just
# re-run `make link-sdk`. `make unlink-sdk` restores the registry versions.

SDK_HOME ?= $(HOME)/sdk

.PHONY: setup check dev build start clean link-sdk unlink-sdk help \
        deploy rollback deploy-status releases install-service install-launchd

REF ?= HEAD

help:
	@echo "make setup      — bun install + prereq check"
	@echo "make check      — read-only prerequisite report (claude/codex CLI, endpoints.yaml, bun)"
	@echo "make dev        — bun --bun run dev"
	@echo "make build      — bun --bun run build"
	@echo "make start      — production build + start on :3088"
	@echo "make link-sdk   — dev only: symlink @smokingmouse/{agent,llm} to a local sm-toolkit checkout (SDK_HOME=$(SDK_HOME))"
	@echo "make unlink-sdk — undo link-sdk, back to registry versions"
	@echo "make clean      — remove node_modules"
	@echo ""
	@echo "── 上线（scripts/deploy.ts）──"
	@echo "make deploy           — 部署 HEAD：新目录里 build + 预检 + 原子切换 + 验活失败自动回滚"
	@echo "make deploy REF=<ref> — 部署指定 ref"
	@echo "make deploy FORCE=1   — 有会话正在生成时也强切（默认拒绝）"
	@echo "make rollback         — 切回上一个 release"
	@echo "make deploy-status    — current/previous、长驻服务与上次部署状态"
	@echo "make releases         — 列出保留的 release"
	@echo "make install-service  — 一次性：把常驻服务（launchd / systemd user unit）的工作目录指向 ~/.trellis/current"

setup:
	bun install
	@$(MAKE) check

check:
	@echo "── prerequisite check ──"
	@command -v bun  >/dev/null && echo "✓ bun  ($$(bun -v))"  || echo "✗ bun not found — https://bun.sh"
	@command -v claude >/dev/null && echo "✓ claude CLI installed" || echo "✗ claude CLI not found — npm i -g @anthropic-ai/claude-code && claude login"
	@command -v codex  >/dev/null && echo "✓ codex CLI installed (optional)" || echo "… codex CLI not found (optional — codex provider won't work without it)"
	@command -v ttyd   >/dev/null && echo "✓ ttyd installed (Web terminal)" || echo "✗ ttyd not found — Web terminal depends on host ttyd; install: brew install ttyd"
	@if [ -n "$$SM_ENDPOINTS_PATH" ] && [ -f "$$SM_ENDPOINTS_PATH" ]; then \
		echo "✓ endpoints.yaml ($$SM_ENDPOINTS_PATH)"; \
	elif [ -f "$(HOME)/.config/sm/endpoints.yaml" ]; then \
		echo "✓ endpoints.yaml (~/.config/sm/endpoints.yaml)"; \
	elif [ -f "$(HOME)/.claude/global/endpoints.yaml" ]; then \
		echo "✓ endpoints.yaml (~/.claude/global/endpoints.yaml, legacy location)"; \
	else \
		echo "… endpoints.yaml missing — native claude/codex/mock still work;"; \
		echo "  for third-party models copy node_modules/@smokingmouse/llm/endpoints.example.yaml"; \
		echo "  to ~/.config/sm/endpoints.yaml and fill in your own providers/keys"; \
	fi
	@if [ -d node_modules/@smokingmouse/agent ] && [ -d node_modules/@smokingmouse/llm ]; then \
		echo "✓ deps installed"; \
	else \
		echo "✗ deps not installed — run: bun install"; \
	fi

link-sdk:
	@test -d "$(SDK_HOME)/packages/agent" || { echo "✗ $(SDK_HOME) is not an sm-toolkit checkout (override with SDK_HOME=...)"; exit 1; }
	cd "$(SDK_HOME)/packages/llm" && bun link
	cd "$(SDK_HOME)/packages/agent" && bun link
	bun link @smokingmouse/llm
	bun link @smokingmouse/agent
	@echo "→ linked to $(SDK_HOME); a future 'bun install' unlinks — re-run 'make link-sdk'"

unlink-sdk:
	bun install --force
	@echo "→ back to registry versions"

dev:
	bun --bun run dev

build:
	bun --bun run build

start: build
	bun --bun run start -- -p 3088

clean:
	rm -rf node_modules

# 上线。**不要**再在这个目录里 `make build` 然后 kickstart —— 那套原地换 .next
# 的做法正是本机制要取代的东西（S66 踩过：进程内旧模块 + 磁盘新文件混跑）。
deploy:
	bun scripts/deploy.ts $(REF) $(if $(FORCE),--force,)

rollback:
	bun scripts/deploy.ts rollback

deploy-status:
	@bun scripts/deploy.ts status

releases:
	@bun scripts/deploy.ts releases

install-service:
	bun scripts/deploy.ts install-service

# 旧名字（那时只有 macOS 一台）。留着当别名。
install-launchd: install-service
