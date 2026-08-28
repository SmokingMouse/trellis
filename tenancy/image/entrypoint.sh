#!/bin/sh
set -eu

# A named volume is seeded only once. Re-create the expected skeleton on every
# boot so image upgrades can introduce new home directories idempotently.
for dir in \
  "$HOME/.trellis" \
  "$HOME/.claude" \
  "$HOME/.config/sm" \
  "$HOME/work"
do
  mkdir -p "$dir"
done

exec bun --bun run start -- -p 3088
