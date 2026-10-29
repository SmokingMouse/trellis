// 客户端「秒开」缓存：会话列表 + 最近打开的少量会话的节点数据，存 IndexedDB。
//
// 为什么在页面里而不是 SW 里：/api 响应带鉴权数据，SW 一律不缓存（public/sw.js）；这里
// 存的是页面自己已经拿到、已经渲染过的数据，同源、同设备、登出即清（clearOfflineData，
// app/login/page.tsx 调）。localStorage 有 5MB 上限且同步阻塞，长会话的节点数据很容易
// 撑爆，所以用 IndexedDB。
//
// 只是加速与断线兜底：任何读写失败（隐私模式、配额、浏览器不支持）都静默降级为「没缓存」，
// 绝不影响正常的网络加载路径。

const DB_NAME = "trellis-offline";
const STORE = "kv";
const SCHEMA = 1;
/** 最多留几个会话的节点数据（按最近打开排序）。 */
export const RECENT_SESSION_LIMIT = 8;

const LIST_KEY = "sessions-list";
const RECENT_KEY = "recent-sessions";
const sessionKey = (id: string) => `session:${id}`;

type Envelope<T> = { schema: number; savedAt: number; data: T };

// ── 纯逻辑（bun test 覆盖）────────────────────────────────────────────────

/** 把 id 提到最近列表最前，超出上限的挤出去（返回被挤出的，调用方删对应条目）。 */
export function touchRecent(list: readonly string[], id: string, limit = RECENT_SESSION_LIMIT): {
  next: string[];
  evicted: string[];
} {
  const rest = list.filter((x) => x !== id);
  const all = [id, ...rest];
  return { next: all.slice(0, limit), evicted: all.slice(limit) };
}

/** 网络加载失败时能不能退到缓存：断网 / 超时（fetch 抛错）、或网关 / 隧道 5xx 才算「连不上」。
 *  4xx（会话被删、未登录）是服务端的明确回答，不能拿旧缓存糊过去。主动取消不算。 */
export function isConnectivityFailure(failure: { status: number } | unknown): boolean {
  if (failure && typeof failure === "object" && "status" in failure && typeof failure.status === "number") {
    return failure.status >= 500;
  }
  if (failure instanceof DOMException && failure.name === "AbortError") return false;
  return true;
}

function unwrap<T>(raw: unknown): T | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as Partial<Envelope<T>>;
  return env.schema === SCHEMA && env.data !== undefined ? (env.data as T) : null;
}

// ── IndexedDB ──────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // 别的标签页要升级 / 删库时让路。
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then((db) => {
    if (!db) dbPromise = null; // 失败不缓存结果，下次再试
    return db;
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? (req.result ?? null) : null);
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

async function kvGet<T>(key: string): Promise<T | null> {
  return unwrap<T>(await run<unknown>("readonly", (s) => s.get(key)));
}

async function kvSet<T>(key: string, data: T): Promise<void> {
  const env: Envelope<T> = { schema: SCHEMA, savedAt: Date.now(), data };
  await run("readwrite", (s) => {
    s.put(env, key);
  });
}

// ── 对外接口 ───────────────────────────────────────────────────────────────

export function readCachedSessionList<T>(): Promise<T | null> {
  return kvGet<T>(LIST_KEY);
}

export function writeCachedSessionList<T>(data: T): Promise<void> {
  return kvSet(LIST_KEY, data);
}

export function readCachedSession<T>(sessionId: string): Promise<T | null> {
  return kvGet<T>(sessionKey(sessionId));
}

/** 写入一个会话的载荷，并把它记为最近打开；超出上限的旧会话一并删掉。 */
export async function writeCachedSession<T>(sessionId: string, data: T): Promise<void> {
  await kvSet(sessionKey(sessionId), data);
  const recent = (await kvGet<string[]>(RECENT_KEY)) ?? [];
  const { next, evicted } = touchRecent(recent, sessionId);
  await run("readwrite", (s) => {
    s.put({ schema: SCHEMA, savedAt: Date.now(), data: next } satisfies Envelope<string[]>, RECENT_KEY);
    for (const id of evicted) s.delete(sessionKey(id));
  });
}

export async function deleteCachedSession(sessionId: string): Promise<void> {
  await run("readwrite", (s) => {
    s.delete(sessionKey(sessionId));
  });
}

/** 登出 / 进登录页：清掉本地会话缓存与 SW 的全部 trellis-* 缓存。 */
export async function clearOfflineData(): Promise<void> {
  await run("readwrite", (s) => {
    s.clear();
  });
  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("trellis-")).map((k) => caches.delete(k)));
    } catch {
      /* 非安全上下文没有 caches */
    }
  }
}
