import "server-only";

// SQLite 写失败的分类 + 文案 + 重试闸（S176，BOE 2026-09-18 13:39 现场）。
//
// 事故形状：/data00 用到 94%，SQLite 连抛三次 `SQLITE_FULL: database or disk is
// full`（瞬时，事后自愈）。而整条写路径上的 `catch {}` 把它们全吞了 —— 用户看到
// 的是「提问转圈、永远不回」，服务端一行日志都没有。
//
// 三条设计判断：
//  · **分类先于重试**：SQLITE_BUSY / LOCKED 是「别人正握着写锁」，退一步再来就好；
//    SQLITE_FULL / IOERR / READONLY 重试一百次也是同一个结果，只会把用户多晾几秒。
//    所以只有前者进退避，后者立刻报。
//  · **抛 DbWriteError 而不是原样上抛**：调用方（run-bus / route）需要一个稳定的
//    判据来区分「DB 写不进去」和「模型自己报错」，字符串匹配那种判据迟早会错。
//  · **文案带可操作提示**：一个 stack 对用户等于没说。`userMessage` 是给人看的那句。

export type SqliteFailureKind =
  | "full" // 磁盘满
  | "io" // 磁盘 / 文件系统 I/O 错误
  | "busy" // 写锁被占（瞬时，可重试）
  | "readonly" // 只读挂载 / 权限
  | "corrupt" // 文件损坏
  | "unknown";

/** 瞬时、值得退避重试的类别。其余一律立刻报错。 */
export function isTransientKind(kind: SqliteFailureKind): boolean {
  return kind === "busy";
}

const CODE_IN_MESSAGE = /SQLITE_[A-Z0-9_]+/;

/** 取 SQLite 错误码。bun:sqlite 的 SQLiteError 带 `.code`；拿不到就从 message 里捞
 * （SDK / 驱动换实现时这层不至于整个瞎掉）。 */
export function sqliteErrorCode(err: unknown): string | null {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("SQLITE_")) return code;
  }
  const m = CODE_IN_MESSAGE.exec(errText(err));
  return m ? m[0] : null;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function classifyDbError(err: unknown): SqliteFailureKind {
  const code = sqliteErrorCode(err) ?? "";
  const msg = errText(err).toLowerCase();
  if (code.startsWith("SQLITE_FULL") || msg.includes("disk is full")) {
    return "full";
  }
  if (code.startsWith("SQLITE_IOERR") || msg.includes("disk i/o error")) {
    return "io";
  }
  if (
    code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    msg.includes("database is locked") ||
    msg.includes("database table is locked")
  ) {
    return "busy";
  }
  if (code.startsWith("SQLITE_READONLY") || msg.includes("readonly database")) {
    return "readonly";
  }
  if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) {
    return "corrupt";
  }
  return "unknown";
}

/** 这个 err 是不是一次 SQLite 写失败（而不是业务异常）。 */
export function isDbFailure(err: unknown): boolean {
  if (err instanceof DbWriteError) return true;
  if (sqliteErrorCode(err)) return true;
  return classifyDbError(err) !== "unknown";
}

function userMessageFor(
  kind: SqliteFailureKind,
  code: string | null,
  raw: string,
  attempts: number,
): string {
  const tag = code ? `（${code}）` : "";
  switch (kind) {
    case "full":
      return `数据库写入失败：磁盘空间不足${tag}。这一轮的内容没能存下来。请先清理 ~/.trellis/data.db 所在分区（或把 TRELLIS_DB_PATH 指到更大的盘），再重试提问。`;
    case "io":
      return `数据库写入失败：磁盘 I/O 错误${tag}。磁盘或文件系统可能出了问题，请检查磁盘健康与挂载状态后重试。`;
    case "busy":
      return `数据库写入失败：数据库长时间被占用${tag}，已重试 ${attempts} 次仍未成功。通常是另一个进程正握着写锁，稍后重试即可。`;
    case "readonly":
      return `数据库写入失败：数据库当前不可写${tag}。请检查 ~/.trellis/data.db 的文件权限与磁盘是否被只读挂载。`;
    case "corrupt":
      return `数据库写入失败：数据库文件可能已损坏${tag}。请停服并从备份恢复，不要继续写入。`;
    default:
      return `数据库写入失败：${raw}`;
  }
}

export class DbWriteError extends Error {
  readonly kind: SqliteFailureKind;
  readonly code: string | null;
  /** 给人看的那句（前端直接显示这个，不显示 stack）。 */
  readonly userMessage: string;
  /** 实际尝试次数（含第一次）。 */
  readonly attempts: number;
  readonly label: string;

  constructor(label: string, cause: unknown, attempts: number) {
    const kind = classifyDbError(cause);
    const code = sqliteErrorCode(cause);
    const raw = errText(cause);
    const userMessage = userMessageFor(kind, code, raw, attempts);
    super(userMessage);
    this.name = "DbWriteError";
    this.kind = kind;
    this.code = code;
    this.userMessage = userMessage;
    this.attempts = attempts;
    this.label = label;
    this.cause = cause;
  }
}

/** 默认尝试次数（含第一次）与退避表。上限刻意小：一次提问最多被拖住约 0.26s，
 * 再久用户宁可看到明确报错也不愿意继续盯着转圈。 */
export const DB_RETRY_ATTEMPTS = 4;
const BACKOFF_MS = [20, 60, 180];

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
    Bun.sleepSync(ms);
    return;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* bun:sqlite 是同步 API，这里只能同步等 */
  }
}

// 测试注入闸：让「磁盘满」这种没法在单测里真的制造出来的故障可被复现。
// 与 resetDBForTests 同一性质 —— 只给测试用，生产路径 fault 永远是 null。
let fault: { code: string; message: string; remaining: number } | null = null;

export function setDbFaultForTests(
  spec: { code: string; message?: string; times?: number } | null,
): void {
  fault = spec
    ? {
        code: spec.code,
        message: spec.message ?? `${spec.code}: injected fault`,
        remaining: spec.times ?? Number.POSITIVE_INFINITY,
      }
    : null;
}

function takeFault(): Error | null {
  if (!fault || fault.remaining <= 0) return null;
  fault.remaining -= 1;
  const e = new Error(fault.message) as Error & { code: string };
  e.code = fault.code;
  return e;
}

/**
 * 包住一次 DB 写。瞬时错误（BUSY/LOCKED）短退避重试，其余立刻抛 DbWriteError。
 *
 * 注意**不要**把读也包进来：读失败不该拖慢路径，也不该被当成「这轮没存下」。
 */
export function dbWrite<T>(
  label: string,
  fn: () => T,
  opts?: { attempts?: number; sleep?: (ms: number) => void },
): T {
  const attempts = Math.max(1, opts?.attempts ?? DB_RETRY_ATTEMPTS);
  const sleep = opts?.sleep ?? sleepSync;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const injected = takeFault();
      if (injected) throw injected;
      return fn();
    } catch (err) {
      if (err instanceof DbWriteError) throw err; // 嵌套 dbWrite：别重复包
      last = err;
      const kind = classifyDbError(err);
      if (!isTransientKind(kind) || i === attempts - 1) {
        throw new DbWriteError(label, err, i + 1);
      }
      sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    }
  }
  // 不可达（循环要么 return 要么 throw），留给类型收敛。
  throw new DbWriteError(label, last, attempts);
}
