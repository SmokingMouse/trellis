#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const DEFAULT_IMAGE = "trellis:dev";
const FIRST_TENANT_PORT = 42001;
const CONTAINER_PORT = 3088;
const STOP_TIMEOUT_SECONDS = 35;
const HEALTH_TIMEOUT_MS = 120_000;
const NAME_RE = /^[a-z0-9-]{1,32}$/;

const REPO_ROOT = resolve(import.meta.dir, "..");
const STATE_ROOT = join(homedir(), ".trellis-tenancy");
const ENV_DIR = join(STATE_ROOT, "env");
const TENANT_DIR = join(STATE_ROOT, "tenants");
const BACKUP_DIR = join(STATE_ROOT, "backups");

type TenantRecord = {
  name: string;
  container: string;
  hostPort: number;
  authToken: string;
  authPass: string;
  image: string;
  createdAt: string;
};

class CliError extends Error {}

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function docker(args: string[], inherit = false): CommandResult {
  const result = spawnSync("docker", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new CliError(`无法执行 docker: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: inherit ? "" : (result.stdout ?? "").trim(),
    stderr: inherit ? "" : (result.stderr ?? "").trim(),
  };
}

function mustDocker(args: string[], inherit = false): CommandResult {
  const result = docker(args, inherit);
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.status}`;
    throw new CliError(`docker ${args[0]} 失败: ${detail}`);
  }
  return result;
}

function validateName(name: string | undefined): asserts name is string {
  if (!name || !NAME_RE.test(name)) {
    throw new CliError("租户名必须匹配 [a-z0-9-]{1,32}");
  }
}

function containerName(name: string): string {
  validateName(name);
  const container = `trellis-${name}`;
  assertSafeContainer(container);
  return container;
}

function assertSafeContainer(container: string): void {
  if (!/^trellis-[a-z0-9-]{1,32}$/.test(container)) {
    throw new CliError(`拒绝操作非 trellis 租户容器: ${container}`);
  }
}

function volumeName(name: string): string {
  validateName(name);
  return `trellis-home-${name}`;
}

function networkName(name: string): string {
  validateName(name);
  return `trellis-net-${name}`;
}

function envPath(name: string): string {
  validateName(name);
  return join(ENV_DIR, `${name}.env`);
}

function recordPath(name: string): string {
  validateName(name);
  return join(TENANT_DIR, `${name}.json`);
}

function ensureStateDirs(): void {
  for (const dir of [STATE_ROOT, ENV_DIR, TENANT_DIR, BACKUP_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function writeRecord(record: TenantRecord): void {
  atomicWrite(recordPath(record.name), `${JSON.stringify(record, null, 2)}\n`);
}

function isTenantRecord(value: unknown): value is TenantRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.name === "string" &&
    NAME_RE.test(item.name) &&
    item.container === `trellis-${item.name}` &&
    Number.isInteger(item.hostPort) &&
    typeof item.authToken === "string" &&
    typeof item.authPass === "string" &&
    typeof item.image === "string" &&
    typeof item.createdAt === "string"
  );
}

function readRecord(name: string): TenantRecord {
  const path = recordPath(name);
  if (!existsSync(path)) {
    throw new CliError(`租户未注册: ${name}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`租户注册文件损坏: ${path} (${String(error)})`);
  }
  if (!isTenantRecord(parsed) || parsed.name !== name) {
    throw new CliError(`租户注册格式无效: ${path}`);
  }
  assertSafeContainer(parsed.container);
  return parsed;
}

function readAllRecords(): TenantRecord[] {
  ensureStateDirs();
  const records: TenantRecord[] = [];
  for (const filename of readdirSync(TENANT_DIR).sort()) {
    if (!filename.endsWith(".json")) continue;
    const name = filename.slice(0, -5);
    if (!NAME_RE.test(name)) continue;
    records.push(readRecord(name));
  }
  return records;
}

function missingDockerObject(result: CommandResult): boolean {
  return /No such (object|container|volume|network)|(?:network|volume) .* not found/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

function containerExists(container: string): boolean {
  assertSafeContainer(container);
  const result = docker(["container", "inspect", container]);
  if (result.status === 0) return true;
  if (missingDockerObject(result)) return false;
  throw new CliError(result.stderr || "docker container inspect 失败");
}

function volumeExists(volume: string): boolean {
  const result = docker(["volume", "inspect", volume]);
  if (result.status === 0) return true;
  if (missingDockerObject(result)) return false;
  throw new CliError(result.stderr || "docker volume inspect 失败");
}

function networkExists(network: string): boolean {
  const result = docker(["network", "inspect", network]);
  if (result.status === 0) return true;
  if (missingDockerObject(result)) return false;
  throw new CliError(result.stderr || "docker network inspect 失败");
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function allocatePort(): Promise<number> {
  const reserved = new Set(readAllRecords().map((record) => record.hostPort));
  for (let port = FIRST_TENANT_PORT; port <= 65535; port++) {
    if (!reserved.has(port) && (await portIsFree(port))) return port;
  }
  throw new CliError(`从 ${FIRST_TENANT_PORT} 起没有可用端口`);
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`无效端口: ${raw ?? "(缺失)"}`);
  }
  return port;
}

function randomSecret(length: number): string {
  let value = "";
  while (value.length < length) {
    value += randomBytes(length).toString("base64url");
  }
  return value.slice(0, length);
}

function createEnvFile(name: string, authPass: string, authToken: string): string {
  const path = envPath(name);
  atomicWrite(
    path,
    `TRELLIS_AUTH_PASS=${authPass}\nTRELLIS_AUTH_TOKEN=${authToken}\n`,
  );
  return path;
}

function ensureResources(name: string): void {
  const network = networkName(name);
  const volume = volumeName(name);
  if (!networkExists(network)) mustDocker(["network", "create", network]);
  if (!volumeExists(volume)) mustDocker(["volume", "create", volume]);
}

function runContainer(record: TenantRecord): void {
  assertSafeContainer(record.container);
  const path = envPath(record.name);
  if (!existsSync(path)) throw new CliError(`env-file 不存在: ${path}`);
  mustDocker([
    "run",
    "-d",
    "--name",
    record.container,
    "--init",
    "--network",
    networkName(record.name),
    "-p",
    `127.0.0.1:${record.hostPort}:${CONTAINER_PORT}`,
    "-v",
    `${volumeName(record.name)}:/home/tenant`,
    "--env-file",
    path,
    "--memory",
    "6g",
    "--cpus",
    "4",
    "--pids-limit",
    "2048",
    "--stop-timeout",
    String(STOP_TIMEOUT_SECONDS),
    "--restart",
    "unless-stopped",
    record.image,
  ]);
}

async function probeReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__gate/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const health = (await response.json()) as { next?: unknown };
    return health.next === "ready";
  } catch {
    return false;
  }
}

async function waitHealthy(record: TenantRecord): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeReady(record.hostPort)) return;
    await Bun.sleep(1000);
  }
  const logs = docker(["logs", "--tail", "100", record.container]);
  const tail = [logs.stdout, logs.stderr].filter(Boolean).join("\n");
  console.error(`容器 ${record.container} 在 120s 内未就绪，日志尾部:`);
  console.error(tail || "(没有日志)");
  throw new CliError(`租户 ${record.name} 健康检查超时`);
}

function stopContainer(record: TenantRecord): void {
  assertSafeContainer(record.container);
  if (!containerExists(record.container)) {
    throw new CliError(`容器不存在: ${record.container}`);
  }
  mustDocker(["stop", "-t", String(STOP_TIMEOUT_SECONDS), record.container]);
}

function takeOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  if (args.indexOf(option, index + 1) >= 0) {
    throw new CliError(`参数重复: ${option}`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError(`参数缺值: ${option}`);
  }
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  if (args.includes(flag)) throw new CliError(`参数重复: ${flag}`);
  return true;
}

function ensureNoArgs(args: string[]): void {
  if (args.length > 0) throw new CliError(`未知参数: ${args.join(" ")}`);
}

async function commandBuild(args: string[]): Promise<void> {
  const tag = takeOption(args, "--tag") ?? DEFAULT_IMAGE;
  ensureNoArgs(args);
  mustDocker(
    ["build", "-f", "tenancy/image/Dockerfile", "-t", tag, "."],
    true,
  );
  console.log(`镜像构建完成: ${tag}`);
}

async function commandAdd(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  ensureStateDirs();
  const portArg = takeOption(args, "--port");
  const image = takeOption(args, "--image") ?? DEFAULT_IMAGE;
  ensureNoArgs(args);

  const container = containerName(name);
  if (existsSync(recordPath(name))) throw new CliError(`租户已注册: ${name}`);
  if (containerExists(container)) throw new CliError(`容器已存在: ${container}`);

  const hostPort = portArg ? parsePort(portArg) : await allocatePort();
  if (!(await portIsFree(hostPort))) {
    throw new CliError(`端口已被占用: ${hostPort}`);
  }

  const authPass = randomSecret(16);
  const authToken = randomSecret(32);
  const record: TenantRecord = {
    name,
    container,
    hostPort,
    authToken,
    authPass,
    image,
    createdAt: new Date().toISOString(),
  };

  ensureResources(name);
  createEnvFile(name, authPass, authToken);
  runContainer(record);
  await waitHealthy(record);
  writeRecord(record);

  console.log(`租户已就绪: ${name}`);
  console.log(`端口: ${hostPort}`);
  console.log(`PASS: ${authPass}`);
  console.log("请保存以上 PASS；tenantctl 不会在后续命令中再次展示。");
}

async function commandStart(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  ensureNoArgs(args);
  const record = readRecord(name);
  if (!containerExists(record.container)) {
    throw new CliError(`容器不存在: ${record.container}；可用 upgrade 重建`);
  }
  mustDocker(["start", record.container]);
  await waitHealthy(record);
  console.log(`租户已启动: ${name}`);
}

async function commandStop(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  ensureNoArgs(args);
  const record = readRecord(name);
  stopContainer(record);
  console.log(`租户已停止: ${name}`);
}

async function commandRestart(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  ensureNoArgs(args);
  const record = readRecord(name);
  stopContainer(record);
  mustDocker(["start", record.container]);
  await waitHealthy(record);
  console.log(`租户已重启: ${name}`);
}

async function confirmRemoval(name: string, purge: boolean): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new CliError("非交互环境执行 rm 必须传 --yes");
  }
  const scope = purge ? "容器、volume、network、env 与注册信息" : "容器（保留数据）";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`确认删除租户 ${name} 的${scope}？输入 yes 继续: `);
    if (answer.trim() !== "yes") throw new CliError("已取消");
  } finally {
    rl.close();
  }
}

async function commandRm(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  const purge = takeFlag(args, "--purge");
  const yes = takeFlag(args, "--yes");
  ensureNoArgs(args);
  ensureStateDirs();
  if (!yes) await confirmRemoval(name, purge);

  const container = containerName(name);
  if (containerExists(container)) {
    const running = docker([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      container,
    ]);
    if (running.status !== 0) {
      throw new CliError(running.stderr || `无法读取容器状态: ${container}`);
    }
    if (running.stdout === "true") {
      mustDocker(["stop", "-t", String(STOP_TIMEOUT_SECONDS), container]);
    }
    mustDocker(["rm", container]);
  }

  if (purge) {
    const volume = volumeName(name);
    const network = networkName(name);
    if (volumeExists(volume)) mustDocker(["volume", "rm", volume]);
    if (networkExists(network)) mustDocker(["network", "rm", network]);
    for (const path of [envPath(name), recordPath(name)]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
  console.log(purge ? `租户已彻底删除: ${name}` : `租户容器已删除（数据保留）: ${name}`);
}

function dockerPsStatus(container: string): string {
  assertSafeContainer(container);
  const result = docker([
    "ps",
    "-a",
    "--filter",
    `name=^/${container}$`,
    "--format",
    "{{.Status}}",
  ]);
  if (result.status !== 0) throw new CliError(result.stderr || "docker ps 失败");
  return result.stdout || "missing";
}

function volumeDiskUsage(volume: string): string {
  const result = docker(["system", "df", "-v", "--format", "json"]);
  if (result.status !== 0) return "unknown";
  for (const line of result.stdout.split("\n")) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const rows = Array.isArray(row.Volumes)
        ? (row.Volumes as Record<string, unknown>[])
        : [row];
      const match = rows.find((item) => item.Name === volume);
      if (match) {
        const size = match.Size ?? match.UsageData ?? match.Usage;
        return typeof size === "string" ? size : JSON.stringify(size ?? "unknown");
      }
    } catch {
      // Docker versions differ in formatting; an unknown size must not hide status.
    }
  }
  return volumeExists(volume) ? "unknown" : "missing";
}

async function printStatus(record: TenantRecord): Promise<void> {
  const status = dockerPsStatus(record.container);
  const ready = await probeReady(record.hostPort);
  const usage = volumeDiskUsage(volumeName(record.name));
  console.log(
    `${record.name}\tcontainer=${status}\thealth=${ready ? "ready" : "unavailable"}` +
      `\tport=${record.hostPort}\tvolume=${usage}`,
  );
}

async function commandStatus(name: string | undefined, args: string[]): Promise<void> {
  ensureNoArgs(args);
  if (name) {
    validateName(name);
    await printStatus(readRecord(name));
    return;
  }
  const records = readAllRecords();
  if (records.length === 0) {
    console.log("没有已注册租户");
    return;
  }
  for (const record of records) await printStatus(record);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function utcTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

async function recreateContainer(record: TenantRecord): Promise<void> {
  assertSafeContainer(record.container);
  if (!existsSync(envPath(record.name))) {
    throw new CliError(`env-file 不存在，拒绝无认证重建: ${envPath(record.name)}`);
  }

  if (containerExists(record.container)) {
    stopContainer(record);
    mustDocker(["rm", record.container]);
  }
  ensureResources(record.name);
  runContainer(record);
  await waitHealthy(record);
  writeRecord(record);
}

async function commandUpgrade(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  const requestedImage = takeOption(args, "--image");
  ensureNoArgs(args);
  const existing = readRecord(name);
  const upgraded: TenantRecord = {
    ...existing,
    image: requestedImage ?? existing.image,
  };
  await recreateContainer(upgraded);
  console.log(`租户升级完成: ${name} (${upgraded.image})`);
}

async function commandPort(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  ensureNoArgs(args);
  console.log(readRecord(name).hostPort);
}

async function commandCredsShare(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  const claudeToken = takeOption(args, "--claude-token");
  const revoke = takeFlag(args, "--revoke");
  ensureNoArgs(args);

  if (claudeToken !== undefined && revoke) {
    throw new CliError("--claude-token 与 --revoke 互斥");
  }
  if (claudeToken === undefined && !revoke) {
    throw new CliError("必须指定 --claude-token <tok> 或 --revoke");
  }
  if (claudeToken !== undefined && !claudeToken.trim()) {
    throw new CliError("token 不能为空");
  }

  const record = readRecord(name);
  const path = envPath(name);
  if (!existsSync(path)) {
    throw new CliError(`env-file 不存在: ${path}`);
  }

  const current = readFileSync(path, "utf8");
  const lines = current
    .split("\n")
    .filter((line) => !line.startsWith("CLAUDE_CODE_OAUTH_TOKEN="));
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (claudeToken !== undefined) {
    lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${claudeToken.trim()}`);
  }
  atomicWrite(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");

  await recreateContainer(record);

  if (claudeToken !== undefined) {
    const trimmed = claudeToken.trim();
    const masked = trimmed.length > 4 ? `...${trimmed.slice(-4)}` : trimmed;
    console.log(`租户凭证共享完成: ${name} (CLAUDE_CODE_OAUTH_TOKEN: ${masked})`);
    console.log("共享 = 租户可提取该 token(env 对容器内进程全程可见)");
    console.log("撤销 = creds-share --revoke(或换 token 后重新 share)");
  } else {
    console.log(`租户凭证已撤销: ${name}`);
  }
}

async function commandBackup(name: string | undefined, args: string[]): Promise<void> {
  validateName(name);
  ensureNoArgs(args);
  readRecord(name);
  const volume = volumeName(name);
  if (!volumeExists(volume)) {
    throw new CliError(`volume 不存在: ${volume}`);
  }

  console.log("提示: 如需强一致先 stop 再 backup");

  ensureStateDirs();
  const timestamp = utcTimestamp();
  const backupFile = join(BACKUP_DIR, `${name}-${timestamp}.tar.gz`);

  const outFd = openSync(backupFile, "w", 0o600);
  let runError: Error | null = null;
  try {
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/src`,
        "busybox",
        "tar",
        "czf",
        "-",
        "-C",
        "/",
        "src",
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", outFd, "pipe"],
        encoding: "utf8",
      },
    );
    if (result.error) {
      runError = new CliError(`无法执行 docker: ${result.error.message}`);
    } else if (result.status !== 0) {
      const detail = result.stderr || `exit ${result.status}`;
      runError = new CliError(`备份 volume 失败: ${detail}`);
    }
  } finally {
    closeSync(outFd);
  }

  if (runError) {
    if (existsSync(backupFile)) {
      try {
        unlinkSync(backupFile);
      } catch {}
    }
    throw runError;
  }
  chmodSync(backupFile, 0o600);

  const stat = statSync(backupFile);
  console.log(`归档路径: ${backupFile}`);
  console.log(`归档大小: ${formatBytes(stat.size)} (${stat.size} 字节)`);
}

function usage(): string {
  return `用法:
  tenantctl build [--tag <t>]
  tenantctl add <name> [--port <p>] [--image <tag>]
  tenantctl start|stop|restart <name>
  tenantctl rm <name> [--purge] [--yes]
  tenantctl status [name]
  tenantctl upgrade <name> [--image <tag>]
  tenantctl port <name>
  tenantctl creds-share <name> (--claude-token <tok> | --revoke)
  tenantctl backup <name>`;
}

async function main(): Promise<void> {
  const [command, name, ...rest] = process.argv.slice(2);
  switch (command) {
    case "build":
      await commandBuild([name, ...rest].filter((value): value is string => value !== undefined));
      break;
    case "add":
      await commandAdd(name, rest);
      break;
    case "start":
      await commandStart(name, rest);
      break;
    case "stop":
      await commandStop(name, rest);
      break;
    case "restart":
      await commandRestart(name, rest);
      break;
    case "rm":
      await commandRm(name, rest);
      break;
    case "status":
      await commandStatus(name, rest);
      break;
    case "upgrade":
      await commandUpgrade(name, rest);
      break;
    case "port":
      await commandPort(name, rest);
      break;
    case "creds-share":
      await commandCredsShare(name, rest);
      break;
    case "backup":
      await commandBackup(name, rest);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(usage());
      break;
    default:
      throw new CliError(`${command ? `未知命令: ${command}\n` : ""}${usage()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
