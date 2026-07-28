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

.PHONY: setup check dev build start clean link-sdk unlink-sdk help

help:
	@echo "make setup      — bun install + prereq check"
	@echo "make check      — read-only prerequisite report (claude/codex CLI, endpoints.yaml, bun)"
	@echo "make dev        — bun --bun run dev"
	@echo "make build      — bun --bun run build"
	@echo "make start      — production build + start on :3088"
	@echo "make link-sdk   — dev only: symlink @smokingmouse/{agent,llm} to a local sm-toolkit checkout (SDK_HOME=$(SDK_HOME))"
	@echo "make unlink-sdk — undo link-sdk, back to registry versions"
	@echo "make clean      — remove node_modules"

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
