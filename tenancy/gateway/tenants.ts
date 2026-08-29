import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Tenant = {
  name: string;
  hostPort: number;
  authToken: string;
  kind: "container" | "host";
};
const cache = new Map<string, { mtimeMs: number; size: number; tenant: Tenant }>();

export function tenantsDir(): string {
  return process.env.TRELLIS_GW_TENANTS_DIR || join(homedir(), ".trellis-tenancy", "tenants");
}

export function getTenant(name: string): Tenant | null {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    return null;
  }
  const file = join(tenantsDir(), `${name}.json`);
  try {
    const stat = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.tenant;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Tenant>;
    if (
      raw.name !== name ||
      !Number.isInteger(raw.hostPort) ||
      raw.hostPort! < 1 ||
      raw.hostPort! > 65535 ||
      typeof raw.authToken !== "string" ||
      !raw.authToken
    ) return null;
    const kind = typeof (raw as { container?: unknown }).container === "string"
      ? "container"
      : "host";
    const tenant = { name, hostPort: raw.hostPort, authToken: raw.authToken, kind } as Tenant;
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, tenant });
    return tenant;
  } catch {
    cache.delete(file);
    return null;
  }
}
