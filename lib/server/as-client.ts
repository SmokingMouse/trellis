import { AgentClient } from "@smokingmouse/agent-server/client";
import { loadToken, resolveDaemonPaths } from "@smokingmouse/agent-server/paths";
import { NotificationSchemas, type NotificationMethod, type ServerNotification } from "@smokingmouse/agent-server/protocol";
import type { ShadowEvent } from "../as-shadow";

export interface ShadowOptions {
  socketPath?: string;
  token?: string;
  tokenPath?: string;
  retryMs?: number;
  warn?: (message: string) => void;
}

/** One observer per SSE consumer: cursors and reconnect snapshots never cross tabs. */
export class ShadowClient {
  private client?: AgentClient;
  private stopped = false;
  private connecting?: Promise<AgentClient>;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(event: ShadowEvent) => void>();
  private threadId?: string;
  private cursor = 0;
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
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
  private warn(error: unknown) {
    (this.options.warn ?? console.warn)(`[trellis/as] ${error instanceof Error ? error.message : String(error)}`);
  }
  connect(): Promise<AgentClient> {
    if (this.stopped) return Promise.reject(new Error("observer closed"));
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(): Promise<AgentClient> {
    clearTimeout(this.timer);
    try {
      if (!this.client || this.client.state === "closed") {
        const paths = resolveDaemonPaths();
        const client = new AgentClient({ transport: "unix", path: this.options.socketPath ?? process.env.TRELLIS_AS_SOCKET ?? paths.socketPath }, {
          token: this.options.token ?? loadToken(this.options.tokenPath ?? process.env.TRELLIS_AS_TOKEN_PATH ?? paths.tokenPath),
          client: { name: "trellis-shadow", version: "0.1.0", kind: "web", label: "Trellis 只读" },
          // Do not become an approval responder: this must not change orphan policy.
          capabilities: { serverRequests: [] },
          connectTimeoutMs: 1500, requestTimeoutMs: 5000,
          reconnect: { minDelayMs: this.options.retryMs ?? 1000, maxDelayMs: 10000 },
        });
        this.client = client;
        client.onError(error => this.warn(error));
        client.onStateChange(state => this.emit({ type: "connection", state }));
        client.onSnapshot(snapshot => {
          this.cursor = Math.max(this.cursor, snapshot.nextSeq - 1);
          this.emit({ type: "snapshot", snapshot });
        });
        for (const method of Object.keys(NotificationSchemas) as NotificationMethod[]) {
          client.onNotification(method, params => {
            if (!("threadId" in params) || params.threadId !== this.threadId) return;
            if ("seq" in params) this.cursor = Math.max(this.cursor, params.seq);
            this.emit({ type: "notification", notification: { jsonrpc: "2.0", method, params } as ServerNotification });
          });
        }
      }
      await this.client.connect();
      return this.client;
    } catch (error) {
      this.warn(error);
      // The upstream library retries only after its first successful handshake.
      if (!this.stopped) {
        this.timer = setTimeout(() => { void this.connect().catch(() => {}); }, this.options.retryMs ?? 5000);
        this.timer.unref?.();
      }
      throw error;
    }
  }
  async listThreads(cursor?: string) {
    return (await this.connect()).request("thread/list", { limit: 100, ...(cursor ? { cursor } : {}) });
  }
  async attach(threadId: string, sinceSeq = 0) {
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw new Error("invalid sinceSeq");
    if (this.threadId && this.threadId !== threadId) throw new Error("one thread per observer");
    this.threadId = threadId;
    this.cursor = sinceSeq;
    const client = await this.connect();
    const snapshot = await client.request("thread/attach", { threadId, sinceSeq });
    // AS v1 has no read-only pending-request notification. Refresh snapshots without
    // declaring approval capabilities; deltas remain live and snapshots upsert by id.
    if (!this.poll) this.poll = setInterval(() => {
      if (this.polling || client.state !== "connected") return;
      this.polling = true;
      void client.request("thread/attach", { threadId, sinceSeq: this.cursor })
        .catch(error => this.warn(error)).finally(() => { this.polling = false; });
    }, 2000);
    this.poll.unref?.();
    return snapshot;
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.client?.close();
    this.listeners.clear();
  }
}

const globalAs = globalThis as typeof globalThis & { trellisShadow?: ShadowClient };
export function getShadowClient() {
  return globalAs.trellisShadow ??= new ShadowClient();
}
