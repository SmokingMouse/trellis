import "server-only";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { notify } from "./notify";

// S95: claude / codex CLI 的授权健康探测 + 到期预警。
//
// 动机是 S90→S93 那次故障：prod spawn 的 claude 全部认证失败，**挂了 6 天没人
// 知道**——错误只出现在没人看的会话里，凭证的时效没有任何地方可见。这层做两件事：
//   T0 `getAuthHealth()`：给 /api/auth-health 和设置页一个只读快照；
//   T1 `checkAuthAlerts()`：scheduler 每小时调一次，硬条件命中就走 notify 推送。
//
// 事实依据（S93 实测 + claude-code-guide 查证，都记在 sessions.md S93/S95）：
//  · `claude auth status --json` 是官方状态出口（2.1.207 实测），但**不含过期时间**；
//  · 过期时间只能读 `~/.claude/.credentials.json`——**非公开 API**，所以解析失败
//    一律降级成「未知」，绝不让整个探测报错；
//  · macOS Keychain 里的 `Claude Code-credentials` 是第二份存储。launchd 上下文的
//    claude 读它、终端读文件，副本停更（refresh token 被文件侧轮换作废）就是 S93
//    的根因 —— 所以这里带一个「分叉哨兵」；
//  · codex 走 `codex login status`；trellis 的 codex 运行通常经 config.toml 的
//    第三方 provider（静态 key），ChatGPT 登录态只影响官方模式 → codex 只展示不告警。

export type CliAuthHealth = {
  installed: boolean;
  /** null = 探测失败（区别于明确的未登录） */
  loggedIn: boolean | null;
  method: string | null;
  subscription: string | null;
  account: string | null;
  /** access token 过期时刻（ms）。null = 未知（文件缺失/解析失败） */
  accessExpiresAt: number | null;
  /** refresh token 过期时刻（ms）——这个过了才是真死（CLI 自己会用 refresh 续 access） */
  refreshExpiresAt: number | null;
  /** 凭证最后一次落盘（claude=credentials.json mtime；codex=auth.json 的 last_refresh） */
  credentialUpdatedAt: number | null;
  warnings: string[];
  errors: string[];
};

export type AuthHealth = {
  claude: CliAuthHealth;
  codex: CliAuthHealth;
  checkedAt: number;
};

const PROBE_TIMEOUT_MS = 10_000;
/** refresh token 剩余不足这个数就预警——过期后修复要人工走登录，留 3 天余量。 */
const REFRESH_WARN_MS = 72 * 3600_000;
/** keychain 副本落后文件超过这个数判分叉（正常同步不会差出两天）。 */
const SPLIT_BRAIN_LAG_MS = 48 * 3600_000;

async function runCmd(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string } | null> {
  try {
    // cwd 固定 homedir：S88 实测 cwd 不存在时 spawn 的 ENOENT 是异步
    // uncaughtException，try/catch 兜不住 —— 别给它机会。
    const proc = Bun.spawn(argv, {
      cwd: os.homedir(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return { code: proc.exitCode ?? -1, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // 二进制不存在（PATH 里没有）等 spawn 期失败
  }
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

function readClaudeCredentialFile(): {
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  mtime: number | null;
} {
  const p = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const mtime = fs.statSync(p).mtimeMs;
    const o = JSON.parse(fs.readFileSync(p, "utf8"))?.claudeAiOauth;
    return {
      accessExpiresAt: typeof o?.expiresAt === "number" ? o.expiresAt : null,
      refreshExpiresAt:
        typeof o?.refreshTokenExpiresAt === "number" ? o.refreshTokenExpiresAt : null,
      mtime,
    };
  } catch {
    return { accessExpiresAt: null, refreshExpiresAt: null, mtime: null };
  }
}

/** macOS Keychain 里第二份凭证的最后写入时刻；条目不存在 / 非 macOS → null。 */
async function keychainItemMtime(): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  const r = await runCmd([
    "/usr/bin/security",
    "find-generic-password",
    "-s",
    "Claude Code-credentials",
  ]);
  if (!r || r.code !== 0) return null;
  // 形如 "mdat"<timedate>=0x… "20260726020027Z\000"
  const m = /"mdat"<timedate>=[^"]*"(\d{14})Z/.exec(r.stdout + r.stderr);
  if (!m) return 0; // 条目在但读不出时间：仍要报「存在第二份存储」
  const [, t] = m;
  return Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(4, 6)) - 1,
    Number(t.slice(6, 8)),
    Number(t.slice(8, 10)),
    Number(t.slice(10, 12)),
    Number(t.slice(12, 14)),
  );
}

async function probeClaude(): Promise<CliAuthHealth> {
  const h: CliAuthHealth = {
    installed: false,
    loggedIn: null,
    method: null,
    subscription: null,
    account: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    credentialUpdatedAt: null,
    warnings: [],
    errors: [],
  };

  const r = await runCmd(["claude", "auth", "status", "--json"]);
  if (!r) {
    // S91 就点过名的隐患：plist 的 PATH 写死 nvm 版本目录，node 一升级 claude
    // 就从 prod 的 PATH 消失 —— 这里让它第一次有了可见的症状。
    h.errors.push("PATH 里找不到 claude —— prod spawn 会全部失败（nvm 升级后 plist PATH 失效是已知诱因）");
    return h;
  }
  h.installed = true;
  try {
    const s = JSON.parse(r.stdout);
    h.loggedIn = Boolean(s.loggedIn);
    h.method = typeof s.authMethod === "string" ? s.authMethod : null;
    h.subscription = typeof s.subscriptionType === "string" ? s.subscriptionType : null;
    h.account = typeof s.email === "string" ? s.email : null;
  } catch {
    h.loggedIn = r.code === 0 ? null : false;
    h.errors.push(`claude auth status 输出无法解析（exit ${r.code}）`);
  }
  // authMethod 语义翻译（S96，2026-08-05 逐来源实测）：`oauth_token` = 登录态来自
  // ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN 环境变量，不是本机交互登录；
  // 且 status **不验证 token 有效性**——塞假值照样报 loggedIn:true。不译出来的话
  // 「我没登录过，卡片却说已登录」（二号机实况）就是必然的困惑。
  if (h.method === "oauth_token") {
    h.method = "环境变量 token";
    h.warnings.push(
      "登录态来自环境变量（ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN），非本机 claude auth login；status 不验证 token 有效性，能不能用以真实请求为准",
    );
  }
  if (h.loggedIn === false) h.errors.push("claude 未登录 —— 需要重新走一次 claude auth login");

  const f = readClaudeCredentialFile();
  h.accessExpiresAt = f.accessExpiresAt;
  h.refreshExpiresAt = f.refreshExpiresAt;
  h.credentialUpdatedAt = f.mtime;

  const now = Date.now();
  if (h.refreshExpiresAt !== null) {
    if (h.refreshExpiresAt <= now) {
      h.errors.push("refresh token 已过期 —— access 一到期就无法续命，需要重新登录");
    } else if (h.refreshExpiresAt - now < REFRESH_WARN_MS) {
      const d = new Date(h.refreshExpiresAt);
      h.warnings.push(
        `refresh token 将于 ${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} 过期，最近保持终端 claude 有使用即可自动续`,
      );
    }
  }

  // 分叉哨兵（S93 根因的复发检测）：keychain 副本存在且落后文件太多 = launchd
  // 上下文的 spawn 可能又在读死凭证。
  const kc = await keychainItemMtime();
  if (kc !== null && f.mtime !== null && kc < f.mtime - SPLIT_BRAIN_LAG_MS) {
    h.warnings.push(
      "Keychain 里存在停更的凭证副本（落后文件 48h+）—— launchd spawn 的 claude 可能读到死凭证（S93 同病），修法：security delete-generic-password -s \"Claude Code-credentials\"",
    );
  }

  return h;
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

async function probeCodex(): Promise<CliAuthHealth> {
  const h: CliAuthHealth = {
    installed: false,
    loggedIn: null,
    method: null,
    subscription: null,
    account: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    credentialUpdatedAt: null,
    warnings: [],
    errors: [],
  };

  const r = await runCmd(["codex", "login", "status"]);
  if (!r) {
    h.warnings.push("PATH 里找不到 codex（只影响 codex 系 provider）");
    return h;
  }
  h.installed = true;
  const out = (r.stdout + r.stderr).trim();
  if (/logged in/i.test(out) && !/not logged in/i.test(out)) {
    h.loggedIn = true;
    h.method = out.split("\n")[0]?.trim() || null;
  } else {
    h.loggedIn = r.code === 0 ? null : false;
    if (h.loggedIn === false) {
      // 只展示不进 errors：走第三方端点注入的 codex 会话不依赖 ChatGPT 登录。
      // 但「不受影响」是有条件的（S96 二号机实锅）——注入生效要求 endpoints.yaml
      // 对应端点带 codex 标记且本机有 key，缺一个就降级回原生模式撞上这里的未登录。
      h.warnings.push(
        "codex 未登录 ChatGPT —— 原生模式不可用；第三方端点注入不依赖它，但要求 endpoints.yaml 端点带 codex 标记 + 本机配好 key（缺失时会话报错里会带具体原因，SDK ≥0.5.1）",
      );
    }
  }

  try {
    const p = path.join(os.homedir(), ".codex", "auth.json");
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    const lr = Date.parse(d?.last_refresh ?? "");
    h.credentialUpdatedAt = Number.isNaN(lr) ? fs.statSync(p).mtimeMs : lr;
  } catch {
    /* auth.json 缺失就缺失，login status 已经是权威回答 */
  }

  return h;
}

// ---------------------------------------------------------------------------
// 快照（带 30s 缓存 —— 设置页轮询别把 spawn 打成风暴）
// ---------------------------------------------------------------------------

let cache: { data: AuthHealth; at: number } | null = null;
const CACHE_MS = 30_000;

export async function getAuthHealth(force = false): Promise<AuthHealth> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [claude, codex] = await Promise.all([probeClaude(), probeCodex()]);
  const data: AuthHealth = { claude, codex, checkedAt: Date.now() };
  cache = { data, at: Date.now() };
  return data;
}

// ---------------------------------------------------------------------------
// T1 预警：硬条件 → notify（24h 去重，状态落盘防重启失忆）
// ---------------------------------------------------------------------------

const ALERT_STATE_PATH = path.join(os.homedir(), ".trellis", "auth-alerts.json");
const REALERT_MS = 24 * 3600_000;

function readAlertState(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(ALERT_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** scheduler 每小时调一次（+启动时一次）。自兜异常 —— 预警挂了不能连累 tick。 */
export async function checkAuthAlerts(): Promise<void> {
  try {
    const { claude } = await getAuthHealth(true);
    const now = Date.now();

    // key 稳定 —— 同一条件 24h 内只推一次；条件消失后自然停。
    const conditions: { key: string; title: string; body: string }[] = [];
    if (!claude.installed) {
      conditions.push({
        key: "claude-missing",
        title: "trellis：claude CLI 不可用",
        body: claude.errors[0] ?? "PATH 里找不到 claude",
      });
    } else if (claude.loggedIn === false) {
      conditions.push({
        key: "claude-logged-out",
        title: "trellis：claude 未登录",
        body: "prod spawn 的 claude 会全部认证失败。在终端跑 claude auth login 修复。",
      });
    }
    for (const w of claude.warnings) {
      if (w.startsWith("refresh token")) {
        conditions.push({ key: "claude-refresh-expiring", title: "trellis：claude 凭证即将过期", body: w });
      }
      if (w.startsWith("Keychain")) {
        conditions.push({ key: "claude-split-brain", title: "trellis：凭证双存储又分叉了", body: w });
      }
    }
    for (const e of claude.errors) {
      if (e.startsWith("refresh token")) {
        conditions.push({ key: "claude-refresh-expired", title: "trellis：claude 凭证已过期", body: e });
      }
    }
    if (!conditions.length) return;

    const state = readAlertState();
    let dirty = false;
    for (const c of conditions) {
      if (now - (state[c.key] ?? 0) < REALERT_MS) continue;
      await notify({
        kind: "auth_alert",
        title: c.title,
        body: `${c.body}\n（设置 → 模型与 Provider 查看授权状态）`,
      });
      state[c.key] = now;
      dirty = true;
    }
    if (dirty) {
      fs.mkdirSync(path.dirname(ALERT_STATE_PATH), { recursive: true });
      fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    }
  } catch (e) {
    console.error("[auth-health] 预警检查失败：", e);
  }
}
