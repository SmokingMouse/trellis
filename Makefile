# trellis one-command bootstrap.
#
# trellis's LLM/CLI-runtime layer (@sm/agent + @sm/llm) lives in a separate
# repo, ~/sdk (sm_toolkit), consumed as a `file:` dependency pointing at an
# absolute path. A fresh environment needs that repo cloned + built before
# `bun install` can even resolve — `make setup` does the whole chain in one
# shot. Override SDK_HOME if sm_toolkit already lives somewhere else on this
# machine; `patch-deps` rewrites package.json's file: paths to match either way
# (only writes if the recorded path is actually different, so re-running is a
# no-op on a machine that's already set up).
#
# Two bun-specific gotchas this file works around (see next.config.ts for the
# fuller story on the first one):
#   1. bun's default `file:` linking symlinks every individual file inside
#      the dependency instead of one top-level directory symlink (npm's
#      style). Turbopack's production file tracer can't parse a package.json
#      reached that way. `relink-sdk` replaces bun's per-file symlinks with
#      one clean directory symlink per package after every `bun install`.
#   2. `bun run dev/build/start` alone doesn't force Next/Turbopack's
#      internally-spawned worker processes onto bun's own runtime, so
#      `bun:sqlite` (a Bun-only built-in, used by lib/server/sqlite.ts)
#      fails to resolve inside those workers. `bun --bun run ...` does force
#      it — that's why dev/build/start below all use `--bun`, not plain `run`.

SDK_HOME ?= $(HOME)/sdk
SDK_REPO ?= git@github.com:SmokingMouse/sm-toolkit.git
ENDPOINTS_YAML ?= $(HOME)/.claude/global/endpoints.yaml

.PHONY: setup sdk sdk-build patch-deps relink-sdk check dev build start clean help

help:
	@echo "make setup   — full bootstrap: clone/build ~/sdk, link trellis deps, bun install, prereq check"
	@echo "make sdk     — clone/update ~/sdk (sm_toolkit) only"
	@echo "make sdk-build — build @sm/llm + @sm/agent inside ~/sdk only"
	@echo "make check   — read-only prerequisite report (claude/codex CLI, endpoints.yaml, bun, links)"
	@echo "make dev     — bun --bun run dev"
	@echo "make build   — bun --bun run build"
	@echo "make start   — production build + start on :3088"
	@echo "make clean   — remove trellis's node_modules (does not touch ~/sdk)"
	@echo ""
	@echo "override SDK_HOME=/some/other/path if sm_toolkit isn't at ~/sdk"

setup: sdk sdk-build patch-deps
	bun install
	@$(MAKE) relink-sdk
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
	@SDK_HOME="$(SDK_HOME)" bun -e ' \
		const fs = require("fs"); \
		const sdk = process.env.SDK_HOME; \
		const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); \
		const want = { "@sm/agent": "file:" + sdk + "/packages/agent", "@sm/llm": "file:" + sdk + "/packages/llm" }; \
		let changed = false; \
		for (const k of Object.keys(want)) { if (pkg.dependencies[k] !== want[k]) { pkg.dependencies[k] = want[k]; changed = true; } } \
		if (changed) { fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n"); console.log("package.json updated → " + sdk); } \
		else { console.log("package.json already points at " + sdk); } \
	'

# Replace bun's per-file-symlinked node_modules/@sm/{agent,llm} with a single
# clean top-level directory symlink each (npm's style). See the header
# comment — this is required for Turbopack builds to work at all, not a nice-
# to-have. Idempotent: safe to re-run after every `bun install`.
relink-sdk:
	@SDK_HOME="$(SDK_HOME)" bun -e ' \
		const fs = require("fs"); \
		const sdk = process.env.SDK_HOME; \
		for (const name of ["agent", "llm"]) { \
			const link = "node_modules/@sm/" + name; \
			const target = sdk + "/packages/" + name; \
			if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === target) { \
				console.log(name + ": already a clean symlink"); \
				continue; \
			} \
			fs.rmSync(link, { recursive: true, force: true }); \
			fs.symlinkSync(target, link); \
			console.log(name + ": relinked -> " + target); \
		} \
	'

check:
	@echo "── prerequisite check ──"
	@command -v bun  >/dev/null && echo "✓ bun  ($$(bun -v))"  || echo "✗ bun not found"
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
	@if [ -L node_modules/@sm/agent ] && [ -L node_modules/@sm/llm ]; then \
		echo "✓ trellis deps installed and linked"; \
	else \
		echo "✗ trellis deps not installed/relinked — run: make setup"; \
	fi

dev:
	bun --bun run dev

build:
	bun --bun run build

start: build
	bun --bun run start -- -p 3088

clean:
	rm -rf node_modules
