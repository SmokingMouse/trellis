import { AgentClient } from "@smokingmouse/agent-server/client";
import { loadToken, resolveDaemonPaths } from "@smokingmouse/agent-server/paths";
import { NotificationSchemas, type AttachResult, type NotificationMethod, type ServerNotification } from "@smokingmouse/agent-server/protocol";
import type { ThreadEvent } from "../as-thread-event";

export interface ThreadObserverOptions {
  socketPath?: string;
  token?: string;
  tokenPath?: string;
  retryMs?: number;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}
export function threadRetryDelay(attempt: number, base = 1000) {
  return Math.min(300000, base * 2 ** Math.min(attempt, 20));
}
function snapshotFingerprint(snapshot: AttachResult) {
  return JSON.stringify(snapshot);
}

/** Trellis owns the only retry timer; the library only handles wire/RPC/cursors. */
export class ThreadObserver {
  private client?: AgentClient;
  private attachedClient?: AgentClient;
  private lastSnapshot?: AttachResult;
  private stopped = false;
  private connecting?: Promise<AgentClient>;
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private failure?: Error;
  private listeners = new Set<(event: ThreadEvent) => void>();
  private threadId?: string;
  private cursor = 0;
  private fingerprint?: string;
  constructor(private readonly options: ThreadObserverOptions = {}) {}

  onEvent(listener: (event: ThreadEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: ThreadEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Isolate disconnected consumers. */ }
    }
  }
  private failed(error: unknown) {
    if (this.stopped || this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    (this.options.warn ?? console.warn)(`[trellis/as] ${this.failure.message}`);
  }
  private retry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.connect().catch(() => {});
    }, threadRetryDelay(this.attempts++, this.options.retryMs));
    this.timer.unref?.();
  }
  connect(): Promise<AgentClient> {
    if (this.stopped) return Promise.reject(new Error("observer closed"));
    if (this.connecting) return this.connecting;
    if (this.timer) return Promise.reject(this.failure ?? new Error("observer reconnecting"));
    if (this.client?.state === "connected" && (!this.threadId || this.attachedClient === this.client)) return Promise.resolve(this.client);
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(): Promise<AgentClient> {
    try {
      if (!this.client || this.client.state !== "connected") {
        const old = this.client;
        this.client = undefined; // old callbacks cannot arm timers while replacing it
        old?.close();
        this.fingerprint = undefined; // reconnect snapshots must always reconcile
        this.attachedClient = undefined;
        const paths = resolveDaemonPaths();
        const client = new AgentClient({ transport: "unix", path: this.options.socketPath ?? process.env.TRELLIS_AS_SOCKET ?? paths.socketPath }, {
          token: this.options.token ?? loadToken(this.options.tokenPath ?? process.env.TRELLIS_AS_TOKEN_PATH ?? paths.tokenPath),
          client: { name: "trellis-thread-observer", version: "0.1.0", kind: "web", label: "Trellis 线程状态" },
          capabilities: { serverRequests: [], engineEvents: true, bashInput: true, pendingRequests: true },
          connectTimeoutMs: 1500, requestTimeoutMs: 5000, reconnect: false,
        });
        this.client = client;
        client.onError(error => { if (this.client === client) this.failed(error); });
        client.onStateChange(state => {
          if (this.stopped || this.client !== client) return;
          this.emit({ type: "connection", state });
          if (state === "closed" || state === "disconnected") {
            if (this.attachedClient === client) this.failed(new Error("daemon disconnected; reconnecting"));
            this.attachedClient = undefined;
            this.retry();
          }
        });
        client.onSnapshot(snapshot => {
          if (this.stopped || this.client !== client) return;
          this.lastSnapshot = snapshot;
          this.cursor = Math.max(this.cursor, snapshot.nextSeq - 1);
          const fingerprint = snapshotFingerprint(snapshot);
          if (fingerprint !== this.fingerprint) {
            this.fingerprint = fingerprint;
            this.emit({ type: "snapshot", snapshot });
          }
        });
        for (const method of Object.keys(NotificationSchemas) as NotificationMethod[]) {
          client.onNotification(method, params => {
            if (this.stopped || this.client !== client) return;
            const relevant = ("threadId" in params && params.threadId === this.threadId)
              || (method === "error" && (!("threadId" in params) || !params.threadId));
            if (!relevant) return;
            if ("seq" in params) this.cursor = Math.max(this.cursor, params.seq);
            this.emit({ type: "notification", notification: { jsonrpc: "2.0", method, params } as ServerNotification });
          });
        }
      }
      const client = this.client;
      await client.connect();
      if (this.threadId && this.attachedClient !== client) {
        await client.request("thread/attach", { threadId: this.threadId, sinceSeq: this.cursor });
        this.attachedClient = client;
      }
      if (this.stopped) throw new Error("observer closed");
      clearTimeout(this.timer); this.timer = undefined;
      this.attempts = 0;
      if (this.failure) (this.options.info ?? console.info)("[trellis/as] daemon connection recovered");
      this.failure = undefined;
      return client;
    } catch (error) {
      this.failed(error);
      this.retry();
      throw error;
    }
  }
  async attach(threadId: string, sinceSeq = 0) {
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new Error("invalid sinceSeq");
    if (this.threadId && this.threadId !== threadId) throw new Error("one thread per observer");
    this.threadId = threadId;
    this.cursor = Math.max(this.cursor, sinceSeq);
    await this.connect();
    return this.lastSnapshot!;
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.client?.close();
    this.listeners.clear();
  }
}

/** Separate writable connection; observers never participate in approvals. */
export function createProjectClient(options: {reconnect?: false; observe?: boolean} = {}) {
  const paths = resolveDaemonPaths();
  return new AgentClient({ transport: "unix", path: process.env.TRELLIS_AS_SOCKET ?? paths.socketPath }, {
    token: loadToken(process.env.TRELLIS_AS_TOKEN_PATH ?? paths.tokenPath),
    client: { name: options.observe ? "trellis-adopt" : "trellis-project", version: "0.2.0", kind: "web", label: options.observe ? "Trellis 收编观察" : "Trellis 网页" },
    capabilities: { engineEvents: true, bashInput: !options.observe, pendingRequests: true, serverRequests: options.observe ? [] : [
      "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
      "item/permissions/requestApproval", "item/tool/requestUserInput",
    ] },
    connectTimeoutMs: 1500, requestTimeoutMs: 5000,
    reconnect: options.reconnect ?? { minDelayMs: 1000, maxDelayMs: 30000 },
  });
}

export function supportsMidThreadFork(client: AgentClient) {
  return client.initializeResult?.capabilities.midThreadFork === true;
}

export async function withProjectLease<T>(client: AgentClient, threadId: string, action: () => Promise<T>): Promise<T> {
  if (!client.initializeResult?.capabilities.leases) throw new Error("daemon does not support leases");
  await client.request("thread/lease/acquire", { threadId, ttlMs: 10000 });
  try { return await action(); }
  finally { await client.request("thread/lease/release", { threadId }).catch(() => {}); }
}

export async function setProjectPermission(client: AgentClient, threadId: string,
  permission: import("@smokingmouse/agent-server/protocol").MethodParams<"thread/permission/set">["permission"]) {
  if (!client.initializeResult?.capabilities.engine?.permissionSet) throw new Error("daemon does not support permission/set");
  return withProjectLease(client, threadId, () => client.setPermission({ threadId, permission }));
}
