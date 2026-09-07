#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
SOURCE=${SM_TOOLKIT_DIR:-/Users/smokingmouse/sm-toolkit}
COMMIT=$(git -C "$SOURCE" rev-parse "${SM_TOOLKIT_REF:-HEAD}^{commit}")
STAGE=$(mktemp -d /tmp/trellis-vendor-as-XXXXXX)
trap 'rm -rf "$STAGE"' 0
trap 'exit 130' 2
trap 'exit 143' 15
# Build a committed snapshot, never write dist/node_modules into the source checkout.
git -C "$SOURCE" archive "$COMMIT" | tar -x -C "$STAGE"
(
  cd "$STAGE"
  bun install --ignore-scripts
  bun node_modules/typescript/bin/tsc --build packages/agent-server
)
DEST="$ROOT/vendor/agent-server"
mkdir -p "$DEST"
# This directory is exclusively generated; delete stale build outputs on refresh.
rm -rf "$DEST/dist"
AS_VENDOR_DIST="$STAGE/packages/agent-server/dist" AS_VENDOR_DEST="$DEST/dist" bun -e '
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
cpSync(process.env.AS_VENDOR_DIST, process.env.AS_VENDOR_DEST, { recursive: true, filter: path => !path.endsWith(".map") });
for (const file of readdirSync(process.env.AS_VENDOR_DEST, { recursive: true })) {
  if (!/\.(js|ts)$/.test(file)) continue;
  const path = `${process.env.AS_VENDOR_DEST}/${file}`;
  writeFileSync(path, readFileSync(path, "utf8").replace(/^\/\/# sourceMappingURL=.*$/gm, ""));
}
'
AS_VENDOR_SOURCE="$STAGE/packages/agent-server/package.json" AS_VENDOR_DEST="$DEST/package.json" bun -e '
const source = await Bun.file(process.env.AS_VENDOR_SOURCE).json();
const {name, version, type, license, main, types, exports} = source;
await Bun.write(process.env.AS_VENDOR_DEST, JSON.stringify({name, version, type, license, main, types, exports,
  dependencies: {"@smokingmouse/agent": "0.8.0", zod: "^4.4.3"}}, null, 2) + "\n");
'
printf 'sm-toolkit commit %s\npackage packages/agent-server\nbuild bun tsc --build packages/agent-server\nagent runtime pinned to published 0.8.0 (Trellis baseline)\n' "$COMMIT" > "$DEST/VENDORED_FROM"
echo "Vendored agent-server from $COMMIT"
