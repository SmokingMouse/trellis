import { AgentClient } from "@smokingmouse/agent-server/client";
import { loadToken, resolveDaemonPaths } from "@smokingmouse/agent-server/paths";
import { NotificationSchemas, type AttachResult, type NotificationMethod, type ServerNotification } from "@smokingmouse/agent-server/protocol";
import type { ShadowEvent } from "../as-shadow";

export interface ShadowOptions {
  socketPath?: string;
  token?: string;
  tokenPath?: string;
  retryMs?: number;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}
export function shadowRetryDelay(attempt: number, base = 1000) {
  return Math.min(300000, base * 2 ** Math.min(attempt, 20));
}
function snapshotFingerprint(snapshot: AttachResult) {
  return JSON.stringify([snapshot.thread.status.type, snapshot.nextSeq,
    snapshot.pendingRequests.map(request => request.params.requestId).sort(),
    snapshot.items.filter(item => item.status === "inProgress")
      .map(item => [item.id, JSON.stringify(item.payload).length]).sort()]);
}

/** Trellis owns the only retry timer; the library only handles wire/RPC/cursors. */
export class ShadowClient {
  private client?: AgentClient;
  private attachedClient?: AgentClient;
  private lastSnapshot?: AttachResult;
  private stopped = false;
  private connecting?: Promise<AgentClient>;
  private timer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private lastExternalRetry = -Infinity;
  private failure?: Error;
  private listeners = new Set<(event: ShadowEvent) => void>();
  private threadId?: string;
  private cursor = 0;
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private running = false;
  private fingerprint?: string;
  constructor(private readonly options: ShadowOptions = {}) {}

  onEvent(listener: (event: ShadowEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: ShadowEvent) {
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
    }, shadowRetryDelay(this.attempts++, this.options.retryMs));
    this.timer.unref?.();
  }
  connect(externalRetry = false): Promise<AgentClient> {
    if (this.stopped) return Promise.reject(new Error("observer closed"));
    if (this.connecting) return this.connecting;
    // A list refresh may bypass backoff once per second; concurrent requests share the attempt.
    if (this.timer) {
      const now = performance.now();
      if (!externalRetry || now - this.lastExternalRetry < 1000) {
        return Promise.reject(this.failure ?? new Error("observer reconnecting"));
      }
      this.lastExternalRetry = now;
      clearTimeout(this.timer); this.timer = undefined;
    }
    if (this.client?.state === "connected" && (!this.threadId || this.attachedClient === this.client)) return Promise.resolve(this.client);
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private stopPoll() { clearInterval(this.poll); this.poll = undefined; this.polling = false; }
  private startPoll() {
    if (this.poll || !this.threadId || !this.running) return;
    this.poll = setInterval(() => {
      const client = this.client, threadId = this.threadId;
      if (this.polling || !threadId || client?.state !== "connected") return;
      this.polling = true;
      void client.request("thread/attach", { threadId, sinceSeq: this.cursor })
        .catch(error => this.failed(error)).finally(() => { if (this.client === client) this.polling = false; });
    }, 2000);
    this.poll.unref?.();
  }
  private async open(): Promise<AgentClient> {
    try {
      if (!this.client || this.client.state !== "connected") {
        const old = this.client;
        this.client = undefined; // old callbacks cannot arm timers while replacing it
        old?.close();
        this.stopPoll();
        this.fingerprint = undefined; // reconnect snapshots must always reconcile
        this.attachedClient = undefined;
        const paths = resolveDaemonPaths();
        const client = new AgentClient({ transport: "unix", path: this.options.socketPath ?? process.env.TRELLIS_AS_SOCKET ?? paths.socketPath }, {
          token: this.options.token ?? loadToken(this.options.tokenPath ?? process.env.TRELLIS_AS_TOKEN_PATH ?? paths.tokenPath),
          client: { name: "trellis-shadow", version: "0.1.0", kind: "web", label: "Trellis 只读" },
          capabilities: { serverRequests: [] },
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
            this.stopPoll();
            this.retry();
          }
        });
        client.onSnapshot(snapshot => {
          if (this.stopped || this.client !== client) return;
          this.lastSnapshot = snapshot;
          this.cursor = Math.max(this.cursor, snapshot.nextSeq - 1);
          this.running = snapshot.thread.status.type === "running";
          if (this.running) this.startPoll(); else this.stopPoll();
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
            if (method === "thread/status/changed" && "status" in params) {
              this.running = params.status.type === "running";
              if (this.running) this.startPoll(); else this.stopPoll();
            }
            this.emit({ type: "notification", notification: { jsonrpc: "2.0", method, params } as ServerNotification });
          });
        }
      }
      const client = this.client;
      await client.connect();
      if (this.threadId && this.attachedClient !== client) {
        await client.request("thread/attach", { threadId: this.threadId, sinceSeq: this.cursor });
        this.attachedClient = client;
        this.startPoll();
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
  async listThreads(cursor?: string) {
    return (await this.connect(true)).request("thread/list", { limit: 100, ...(cursor ? { cursor } : {}) });
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
    this.stopPoll();
    this.client?.close();
    this.listeners.clear();
  }
}

const globalAs = globalThis as typeof globalThis & { trellisShadow?: ShadowClient };
export function getShadowClient() { return globalAs.trellisShadow ??= new ShadowClient(); }
