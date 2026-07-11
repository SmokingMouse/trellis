# trellis one-command bootstrap.
#
# trellis's LLM/CLI-runtime layer (@sm/agent + @sm/llm) lives in a separate
# repo, ~/sdk (sm_toolkit), consumed as a `file:` dependency pointing at an
# absolute path. A fresh environment needs that repo cloned + built before
# `npm install` can even resolve — `make setup` does the whole chain in one
# shot. Override SDK_HOME if sm_toolkit already lives somewhere else on this
# machine; `patch-deps` rewrites package.json's file: paths to match either way
# (only writes if the recorded path is actually different, so re-running is a
# no-op on a machine that's already set up).

SDK_HOME ?= $(HOME)/sdk
SDK_REPO ?= git@github.com:SmokingMouse/sm-toolkit.git
ENDPOINTS_YAML ?= $(HOME)/.claude/global/endpoints.yaml

.PHONY: setup sdk sdk-build patch-deps check dev build start clean help

help:
	@echo "make setup   — full bootstrap: clone/build ~/sdk, link trellis deps, npm install, prereq check"
	@echo "make sdk     — clone/update ~/sdk (sm_toolkit) only"
	@echo "make sdk-build — build @sm/llm + @sm/agent inside ~/sdk only"
	@echo "make check   — read-only prerequisite report (claude/codex CLI, endpoints.yaml, node/bun, links)"
	@echo "make dev     — npm run dev"
	@echo "make build   — npm run build"
	@echo "make start   — production build + start on :3088"
	@echo "make clean   — remove trellis's node_modules (does not touch ~/sdk)"
	@echo ""
	@echo "override SDK_HOME=/some/other/path if sm_toolkit isn't at ~/sdk"

setup: sdk sdk-build patch-deps
	npm install
	@$(MAKE) check

sdk:
	@if [ -d "$(SDK_HOME)/.git" ]; then \
		echo "→ $(SDK_HOME) already a git repo, pulling..."; \
		git -C "$(SDK_HOME)" pull --ff-only || echo "  (pull failed/diverged — leaving it as-is)"; \
	else \
		echo "→ cloning sm_toolkit into $(SDK_HOME)"; \
		git clone "$(SDK_REPO)" "$(SDK_HOME)"; \
	fi

sdk-build:
	@echo "→ bun install + build @sm/llm + @sm/agent"
	cd "$(SDK_HOME)" && bun install
	cd "$(SDK_HOME)/packages/llm" && bunx tsc --build
	cd "$(SDK_HOME)/packages/agent" && bunx tsc --build

patch-deps:
	@SDK_HOME="$(SDK_HOME)" node -e ' \
		const fs = require("fs"); \
		const sdk = process.env.SDK_HOME; \
		const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); \
		const want = { "@sm/agent": "file:" + sdk + "/packages/agent", "@sm/llm": "file:" + sdk + "/packages/llm" }; \
		let changed = false; \
		for (const k of Object.keys(want)) { if (pkg.dependencies[k] !== want[k]) { pkg.dependencies[k] = want[k]; changed = true; } } \
		if (changed) { fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n"); console.log("package.json updated → " + sdk); } \
		else { console.log("package.json already points at " + sdk); } \
	'

check:
	@echo "── prerequisite check ──"
	@command -v node >/dev/null && echo "✓ node ($$(node -v))" || echo "✗ node not found"
	@command -v npm  >/dev/null && echo "✓ npm  ($$(npm -v))"  || echo "✗ npm not found"
	@command -v bun  >/dev/null && echo "✓ bun  ($$(bun -v))"  || echo "✗ bun not found — needed to build ~/sdk packages"
	@command -v claude >/dev/null && echo "✓ claude CLI installed" || echo "✗ claude CLI not found — npm i -g @anthropic-ai/claude-code && claude login"
	@command -v codex  >/dev/null && echo "✓ codex CLI installed (optional)" || echo "… codex CLI not found (optional — codex provider won't work without it)"
	@if [ -f "$(ENDPOINTS_YAML)" ]; then \
		echo "✓ $(ENDPOINTS_YAML) exists"; \
	else \
		echo "… $(ENDPOINTS_YAML) missing — native claude/codex/mock still work;"; \
		echo "  for third-party models: cd $(SDK_HOME) && bun run setup"; \
	fi
	@if [ -d "$(SDK_HOME)/packages/agent/dist" ] && [ -d "$(SDK_HOME)/packages/llm/dist" ]; then \
		echo "✓ ~/sdk packages built"; \
	else \
		echo "✗ ~/sdk packages not built — run: make sdk-build"; \
	fi
	@if [ -d node_modules/@sm/agent ] && [ -d node_modules/@sm/llm ]; then \
		echo "✓ trellis deps installed and linked"; \
	else \
		echo "✗ trellis deps not installed — run: make setup"; \
	fi

dev:
	npm run dev

build:
	npm run build

start: build
	npm run start -- -p 3088

clean:
	rm -rf node_modules
