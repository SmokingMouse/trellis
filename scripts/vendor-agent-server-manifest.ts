/** Preserve upstream runtime dependencies; reuse explicit published pins for workspace packages. */
export function vendorManifest(source: {
  name: string; version: string; type?: string; license?: string; main?: string;
  types?: string; exports?: unknown; dependencies?: Record<string, string>;
}, pins: Record<string, string>) {
  const { name, version, type, license, main, types, exports } = source;
  const dependencies = Object.fromEntries(Object.entries(source.dependencies ?? {}).map(([name, range]) => {
    if (range.startsWith("workspace:")) {
      range = pins[name];
      if (!range || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(range)) {
        throw new Error(`Set a published exact version for ${name} in vendor/agent-server/package.json before syncing`);
      }
    }
    return [name, range];
  }));
  return { name, version, type, license, main, types, exports, dependencies };
}

if (import.meta.main) {
  const source = await Bun.file(process.argv[2]).json();
  const destination = process.argv[3];
  const previous = await Bun.file(destination).json();
  await Bun.write(destination, JSON.stringify(vendorManifest(source, previous.dependencies ?? {}), null, 2) + "\n");
}
