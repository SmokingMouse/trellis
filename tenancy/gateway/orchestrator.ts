import { resolve } from "node:path";
import { getTenant, type Tenant } from "./tenants";

type ChildResult = { status: number; stdout: string; stderr: string };
type ProvisionState = { state: "provisioning" | "failed"; detail?: string };

const REPO_ROOT = resolve(import.meta.dir, "../..");
const provisionStates = new Map<string, ProvisionState>();
const statusCache = new Map<string, { expires: number; value: ContainerState }>();

export type ContainerState = {
  state: "running" | "stopped" | "missing" | "host";
  healthy: boolean | null;
};

function commandPrefix(): string[] {
  const configured = process.env.TRELLIS_GW_TENANTCTL?.trim();
  if (!configured) return ["bun", "tenancy/tenantctl.ts"];
  const parts = configured.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => {
    if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  });
}

async function collect(child: ReturnType<typeof Bun.spawn>): Promise<ChildResult> {
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  return { status, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function runTenantctl(args: string[], input?: string): Promise<ChildResult> {
  const child = Bun.spawn({
    cmd: [...commandPrefix(), ...args],
    cwd: REPO_ROOT,
    env: process.env,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    const stdin = child.stdin as unknown as { write(value: string): number; end(): void };
    stdin.write(input);
    stdin.end();
  }
  return collect(child);
}

function tail(result: ChildResult): string {
  return (result.stderr || result.stdout || `exit ${result.status}`).slice(-1000);
}

export function provisionTenant(name: string): void {
  provisionStates.set(name, { state: "provisioning" });
  void runTenantctl(["add", name])
    .then((result) => {
      if (result.status !== 0) {
        provisionStates.set(name, { state: "failed", detail: tail(result) });
      }
    })
    .catch((error) => {
      provisionStates.set(name, {
        state: "failed",
        detail: error instanceof Error ? error.message.slice(-1000) : String(error).slice(-1000),
      });
    });
}

export function registrationStatus(name: string): { state: "provisioning" | "ready" | "failed"; detail?: string } {
  if (getTenant(name)) return { state: "ready" };
  return provisionStates.get(name) ?? { state: "provisioning" };
}

export function restartTenant(name: string): void {
  statusCache.delete(name);
  void runTenantctl(["restart", name]).then((result) => {
    if (result.status !== 0) console.error(`[trellis-gw] restart ${name} failed: ${tail(result)}`);
  }).catch((error) => console.error(`[trellis-gw] restart ${name} failed: ${String(error)}`));
}

async function hostState(tenant: Tenant): Promise<ContainerState> {
  try {
    const response = await fetch(`http://127.0.0.1:${tenant.hostPort}/__gate/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return { state: "host", healthy: response.ok };
  } catch {
    return { state: "host", healthy: null };
  }
}

export async function containerState(name: string): Promise<ContainerState> {
  const tenant = getTenant(name);
  if (!tenant) return { state: "missing", healthy: false };
  if (tenant.kind === "host") return hostState(tenant);
  const cached = statusCache.get(name);
  if (cached && cached.expires > Date.now()) return cached.value;
  const result = await runTenantctl(["inspect", name]);
  let value: ContainerState = { state: "missing", healthy: false };
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as Partial<ContainerState>;
      if (parsed.state === "running" || parsed.state === "stopped" || parsed.state === "missing") {
        value = { state: parsed.state, healthy: typeof parsed.healthy === "boolean" ? parsed.healthy : null };
      }
    } catch { /* malformed helper output becomes missing */ }
  }
  statusCache.set(name, { expires: Date.now() + 3000, value });
  return value;
}
