import "server-only";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { HerdrInputDelivery } from "../herdr-input";
import {
  HERDR_PROTOCOL,
  type HerdrAgent,
  type HerdrClientChange,
  type HerdrClientState,
  type HerdrEvent,
  type HerdrLayout,
  type HerdrPane,
  type HerdrResponse,
  type HerdrSnapshot,
  type HerdrSnapshotResult,
  type HerdrTab,
  type HerdrWorkspace,
} from "./herdr-types";

const STATIC_SUBSCRIPTIONS = [
  "pane.created",
  "pane.closed",
  "pane.exited",
  "pane.updated",
  "pane.agent_detected",
  "pane.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "workspace.created",
  "workspace.updated",
  "workspace.metadata_updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "layout.updated",
].map((type) => ({ type }));

const IMPORTANT_PANE_FIELDS = [
  "agent_status",
  "agent_session",
  "agent",
  "cwd",
  "label",
  "terminal_title",
] as const;

const READ_METHODS = new Set([
  "ping",
  "session.snapshot",
  "events.subscribe",
  "workspace.list",
  "workspace.get",
  "tab.get",
  "pane.list",
  "pane.get",
  "pane.read",
  "pane.layout",
  "pane.process_info",
  "agent.list",
  "agent.get",
  "agent.read",
  "agent.wait",
]);

type ClientOptions = {
  socketPath?: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  coalesceMs?: number;
  queueLimit?: number;
  snapshotIntervalMs?: number;
  silenceIntervalMs?: number;
  healthIntervalMs?: number;
  random?: () => number;
};

type QueuedLine = { raw: string; replay: boolean };

export class HerdrTransportError extends Error {
  readonly kind = "transport";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "HerdrTransportError";
  }
}

export class HerdrApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "HerdrApiError";
  }
}

export class HerdrUnavailableError extends Error {
  constructor(message = "Herdr is unavailable") {
    super(message);
    this.name = "HerdrUnavailableError";
  }
}

export function resolveHerdrSocketPath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.HERDR_SOCKET_PATH) return path.resolve(env.HERDR_SOCKET_PATH);
  if (env.XDG_CONFIG_HOME) {
    return path.join(path.resolve(env.XDG_CONFIG_HOME), "herdr", "herdr.sock");
  }
  const home = env.HOME || os.homedir();
  return path.join(path.resolve(home), ".config", "herdr", "herdr.sock");
}

function transportCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\b(E[A-Z]+)\b/);
  return match?.[1] ?? "SOCKET_ERROR";
}

function connectionError(error: unknown, socketPath: string): HerdrTransportError {
  if (error instanceof HerdrTransportError) return error;
  let code = transportCode(error);
  let message = error instanceof Error ? error.message : String(error);
  // Bun collapses Unix connect failures to ENOENT. Filesystem syscalls retain
  // the distinction between missing paths, non-sockets and permission denial.
  if (code === "ENOENT") {
    try {
      const stat = fs.statSync(socketPath);
      fs.accessSync(socketPath, fs.constants.W_OK);
      if (!stat.isSocket()) { code = "ENOTSOCK"; message = "path is not a Unix socket"; }
    } catch (cause) {
      code = transportCode(cause);
      message = cause instanceof Error ? cause.message : String(cause);
    }
  }
  return new HerdrTransportError(`${code}: ${message}`, code);
}

function sameImportantPaneState(before: HerdrPane, after: HerdrPane): boolean {
  return IMPORTANT_PANE_FIELDS.every(
    (field) => JSON.stringify(before[field]) === JSON.stringify(after[field]),
  );
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class HerdrClient {
  readonly socketPath: string;
  readonly enabled: boolean;

  private readonly requestTimeoutMs: number;
  private readonly coalesceMs: number;
  private readonly queueLimit: number;
  private readonly snapshotIntervalMs: number;
  private readonly silenceIntervalMs: number;
  private readonly healthIntervalMs: number;
  private readonly random: () => number;
  private requestId = 0;
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly listeners = new Set<(change: HerdrClientChange) => void>();
  private readonly workspaces = new Map<string, HerdrWorkspace>();
  private readonly tabs = new Map<string, HerdrTab>();
  private readonly panes = new Map<string, HerdrPane>();
  private readonly layouts = new Map<string, HerdrLayout>();
  private readonly agents = new Map<string, HerdrAgent>();
  private readonly inputTails = new Map<string, Promise<unknown>>();
  private readonly deliveries = new Map<string, HerdrInputDelivery>();

  get inputDeliveries(): HerdrInputDelivery[] {
    return [...this.deliveries.values()];
  }

  private publishDelivery(delivery: HerdrInputDelivery): void {
    this.deliveries.set(delivery.inputId, delivery);
    this.bump();
    this.emit({ kind: "fleet" });
  }
  private eventSocket: Bun.Socket<undefined> | null = null;
  private lineQueue: QueuedLine[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private snapshotting: Promise<boolean> | null = null;
  private closedDuringSnapshot: Set<string> | null = null;
  private stopped = false;
  private baselineReady = false;
  private needsResync = false;
  private reconnectAttempt = 0;
  private lastEventAt = 0;
  private lastSnapshotAt = 0;
  private _available = false;
  private _realtime = false;
  private _readOnly = false;
  private _protocol: number | null = null;
  private _version: string | null = null;
  private _lastError: string | null = null;
  private _generation = 0;
  private fatalTransport = false;

  constructor(options: ClientOptions = {}) {
    const env = options.env ?? process.env;
    this.socketPath = options.socketPath ?? resolveHerdrSocketPath(env);
    this.enabled = env.TRELLIS_HERDR !== "off";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.coalesceMs = options.coalesceMs ?? 200;
    this.queueLimit = options.queueLimit ?? 5_000;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 60_000;
    this.silenceIntervalMs = options.silenceIntervalMs ?? 30_000;
    this.healthIntervalMs = options.healthIntervalMs ?? 5_000;
    this.random = options.random ?? Math.random;
  }

  get state(): HerdrClientState {
    return {
      enabled: this.enabled,
      available: this._available,
      realtime: this._realtime,
      readOnly: this._readOnly,
      protocol: this._protocol,
      version: this._version,
      socketPath: this.socketPath,
      generation: this._generation,
      lastError: this._lastError,
      workspaces: [...this.workspaces.values()],
      tabs: [...this.tabs.values()],
      panes: [...this.panes.values()],
      layouts: [...this.layouts.values()],
      agents: [...this.agents.values()],
    };
  }

  subscribe(listener: (change: HerdrClientChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (!this.enabled || this.stopped) return;
    if (this.starting) return this.starting;
    this.starting = this.startInner().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  stop(): void {
    this.stopped = true;
    this._realtime = false;
    this.baselineReady = false;
    this.eventSocket?.close();
    this.eventSocket = null;
    for (const timer of [
      this.flushTimer,
      this.snapshotTimer,
      this.silenceTimer,
      this.healthTimer,
      this.reconnectTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.flushTimer = null;
    this.snapshotTimer = null;
    this.silenceTimer = null;
    this.healthTimer = null;
    this.reconnectTimer = null;
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (!this.enabled) throw new HerdrUnavailableError("Herdr is disabled");
    if (this._readOnly && !READ_METHODS.has(method)) {
      throw new HerdrUnavailableError(
        `Herdr protocol ${this._protocol} is read-only (expected ${HERDR_PROTOCOL})`,
      );
    }
    if (!this._available && method !== "ping") {
      throw new HerdrUnavailableError();
    }
    try {
      return await this.requestWithRetry<T>(method, params, method === "ping" ? 0 : 2, timeoutMs);
    } catch (error) {
      if (error instanceof HerdrTransportError) this.markDown(error);
      throw error;
    }
  }

  async enqueueInput(
    paneId: string,
    text: string,
    timeoutMs = 300_000,
  ): Promise<HerdrInputDelivery> {
    const acceptedPane = this.requireAgentPane(paneId);
    if (this._readOnly) throw new HerdrUnavailableError("Herdr is read-only");
    // Retain bounded delivery receipts for reconnecting browsers, never evict
    // an input that is still queued. Text stays only in the worker closure.
    for (const [id, delivery] of this.deliveries) {
      if (this.deliveries.size < 128) break;
      if (delivery.status !== "queued") this.deliveries.delete(id);
    }
    if (this.deliveries.size >= 128) throw new HerdrApiError("input queue is full", "queue_full");
    const receipt: HerdrInputDelivery = { inputId: crypto.randomUUID(), paneId, status: "queued" };
    const queued = this.inputTails.has(paneId) || !["idle", "done"].includes(acceptedPane.agent_status);
    const previous = this.inputTails.get(paneId) ?? Promise.resolve();
    const run = previous.then(() => undefined, () => undefined).then(async () => {
      const current = this.requireAgentPane(paneId);
      if (current.agent_status !== "idle" && current.agent_status !== "done") {
        await this.request("agent.wait", {
          target: paneId,
          until: ["idle", "done"],
          timeout_ms: timeoutMs,
        }, timeoutMs + 5_000);
      }
      const target = this.requireAgentPane(paneId);
      if (this.stopped || target.terminal_id !== acceptedPane.terminal_id ||
          JSON.stringify(target.agent_session) !== JSON.stringify(acceptedPane.agent_session)) {
        throw new HerdrApiError("queued input target changed or stopped", "pane_changed");
      }
      await this.request<Record<string, unknown>>("pane.send_input", {
        pane_id: paneId,
        text,
        keys: ["Enter"],
      });
      const delivered: HerdrInputDelivery = { ...receipt, status: "delivered" };
      this.publishDelivery(delivered);
      return delivered;
    });
    this.publishDelivery(receipt);
    void run.catch((error) => {
      this.publishDelivery({ ...receipt, status: "failed", error: error instanceof Error ? error.message : String(error) });
    });
    // Both idle waits belong to the background worker. A busy pane (or an
    // existing queue) acknowledges acceptance immediately, without waiting.
    const tail = run.then(() => this.request("agent.wait", {
        target: paneId,
        until: ["idle", "done"],
        timeout_ms: timeoutMs,
      }, timeoutMs + 5_000));
    this.inputTails.set(paneId, tail);
    void tail.then(
      () => {
        if (this.inputTails.get(paneId) === tail) this.inputTails.delete(paneId);
      },
      (error) => {
        if (this.inputTails.get(paneId) === tail) this.inputTails.delete(paneId);
        if (!this.stopped) console.warn("[trellis] Herdr input queue wait failed", paneId, error);
      },
    );
    return queued ? receipt : run;
  }

  async sendKeys(paneId: string, keys: string[]): Promise<Record<string, unknown>> {
    this.requireAgentPane(paneId);
    return this.request("pane.send_keys", { pane_id: paneId, keys });
  }

  private requireAgentPane(paneId: string): HerdrPane {
    if (!this.enabled || !this._available) throw new HerdrUnavailableError();
    const pane = this.panes.get(paneId);
    if (!pane) throw new HerdrApiError("pane not found", "pane_not_found");
    if (!pane.agent) throw new HerdrApiError("target must be an agent pane", "not_agent_pane");
    return pane;
  }

  async splitAndResume(
    pane: HerdrPane,
    sessionId: string,
    agentKind: string,
    cwd: string | null,
  ): Promise<string> {
    const split = await this.request<Record<string, unknown>>("pane.split", {
      target_pane_id: pane.pane_id,
      workspace_id: pane.workspace_id,
      direction: "right",
      cwd,
      focus: false,
    });
    const created = split.pane as HerdrPane | undefined;
    const paneId = created?.pane_id;
    if (!paneId) throw new HerdrApiError("pane.split returned no pane", "bad_response");
    const command =
      agentKind === "codex"
        ? `codex resume ${shellArgument(sessionId)}`
        : `claude --resume ${shellArgument(sessionId)}`;
    await this.request("pane.send_input", {
      pane_id: paneId,
      text: command,
      keys: ["Enter"],
    });
    return paneId;
  }

  private async startInner(): Promise<void> {
    console.info(`[trellis] Herdr socket: ${this.socketPath}`);
    try {
      await this.probe(0);
      if (this._readOnly) await this.resync();
      else await this.openSubscriptionAndSnapshot();
      this.installTimers();
    } catch (error) {
      this.markDown(error);
      this.installTimers();
    }
  }

  private async probe(retries: number): Promise<void> {
    const pong = await this.requestWithRetry<{
      type: "pong";
      version: string;
      protocol: number;
    }>("ping", {}, retries);
    this._available = true;
    this.fatalTransport = false;
    this._version = pong.version;
    this._protocol = pong.protocol;
    this._readOnly = pong.protocol !== HERDR_PROTOCOL;
    this._lastError = this._readOnly
      ? `protocol mismatch: expected ${HERDR_PROTOCOL}, got ${pong.protocol}`
      : null;
    if (this._readOnly) console.warn(`[trellis] Herdr ${this._lastError}; writes disabled`);
  }

  private installTimers(): void {
    if (!this.snapshotTimer) {
      this.snapshotTimer = setInterval(() => void this.resync(), this.snapshotIntervalMs);
      this.snapshotTimer.unref?.();
    }
    if (!this.silenceTimer) {
      this.silenceTimer = setInterval(() => {
        if (
          this._available &&
          Date.now() - this.lastEventAt >= this.silenceIntervalMs &&
          Date.now() - this.lastSnapshotAt >= this.silenceIntervalMs
        ) {
          void this.resync();
        }
      }, Math.min(this.silenceIntervalMs, 5_000));
      this.silenceTimer.unref?.();
    }
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => {
        if (!this._available && !this.fatalTransport) void this.recover();
      }, this.healthIntervalMs);
      this.healthTimer.unref?.();
    }
  }

  private async recover(): Promise<void> {
    if (this.stopped || this.starting) return;
    try {
      await this.probe(0);
      if (this._readOnly) await this.resync();
      else await this.openSubscriptionAndSnapshot();
    } catch (error) {
      this.markDown(error);
    }
  }

  private markDown(error: unknown): void {
    const code = transportCode(error);
    // An RPC deadline or malformed response says nothing about socket health.
    if (!["ENOENT", "ENOTSOCK", "ECONNREFUSED", "ECONNRESET", "EPIPE", "EACCES", "EPERM", "SOCKET_ERROR", "EOF"].includes(code)) return;
    this.fatalTransport = code === "EACCES" || code === "EPERM";
    this._available = false;
    this._realtime = false;
    this.baselineReady = false;
    this._lastError = error instanceof Error ? error.message : String(error);
    this._generation++;
    const eventSocket = this.eventSocket;
    this.eventSocket = null;
    try {
      eventSocket?.close();
    } catch {
      /* already closed */
    }
    this.emit({ kind: "fleet" });
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < 8) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  private release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  private async requestWithRetry<T>(
    method: string,
    params: Record<string, unknown>,
    retries: number,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    await this.acquire();
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await this.requestOnce<T>(method, params, timeoutMs);
        } catch (error) {
          lastError = error;
          const code = transportCode(error);
          if (
            !(error instanceof HerdrTransportError) ||
            code === "EACCES" ||
            !["ENOENT", "ECONNREFUSED", "SOCKET_ERROR", "EOF"].includes(code) ||
            attempt === retries
          ) {
            throw error;
          }
          await Bun.sleep(attempt === 0 ? 100 : 400);
        }
      }
      throw lastError;
    } finally {
      this.release();
    }
  }

  private requestOnce<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    const id = String(++this.requestId);
    return new Promise<T>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      let socket: Bun.Socket<undefined> | null = null;
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.end();
        } catch {
          /* already closed */
        }
        if (error) reject(error);
        else resolve(value as T);
      };
      const failTransport = (error: unknown) => finish(connectionError(error, this.socketPath));
      const timer = setTimeout(
        () => failTransport(new HerdrTransportError(`${method} timed out`, "ETIMEDOUT")),
        timeoutMs,
      );
      void Bun.connect({
        unix: this.socketPath,
        socket: {
          binaryType: "buffer",
          open(opened) {
            socket = opened;
            opened.write(`${JSON.stringify({ id, method, params })}\n`);
          },
          data(_socket, chunk) {
            buffer += chunk.toString();
            const newline = buffer.indexOf("\n");
            if (newline < 0) return;
            try {
              const response = JSON.parse(buffer.slice(0, newline)) as HerdrResponse<T>;
              if ("error" in response) {
                finish(new HerdrApiError(response.error.message, response.error.code));
              } else {
                finish(undefined, response.result);
              }
            } catch (error) {
              finish(new HerdrTransportError(`invalid ${method} response: ${error}`, "EPROTO"));
            }
          },
          connectError(_socket, error) {
            failTransport(error);
          },
          error(_socket, error) {
            failTransport(error);
          },
          close() {
            if (!settled) {
              failTransport(new HerdrTransportError(`${method} closed without response`, "EOF"));
            }
          },
          end() {
            if (!settled) {
              failTransport(new HerdrTransportError(`${method} ended without response`, "EOF"));
            }
          },
        },
      })
        .then((connected) => {
          socket = connected;
        })
        .catch(failTransport);
    });
  }

  private async openSubscriptionAndSnapshot(): Promise<void> {
    if (this.stopped || !this._available || this.eventSocket) return;
    this.baselineReady = false;
    this.lineQueue = [];
    await this.openEventSocket();
    if (!(await this.resync())) {
      throw new HerdrUnavailableError(this._lastError ?? "initial Herdr snapshot failed");
    }
    this.baselineReady = true;
    this._realtime = true;
    this.reconnectAttempt = 0;
    this.scheduleFlush(0);
    this.emit({ kind: "fleet" });
  }

  private openEventSocket(): Promise<void> {
    const id = `sub-${++this.requestId}`;
    return new Promise<void>((resolve, reject) => {
      let buffer = "";
      let acknowledged = false;
      let socket: Bun.Socket<undefined> | null = null;
      let settled = false;
      const timer = setTimeout(() => {
        if (!acknowledged) fail(new HerdrTransportError("events.subscribe timed out", "ETIMEDOUT"));
      }, this.requestTimeoutMs);
      const fail = (error: unknown) => {
        if (!acknowledged && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            error instanceof Error
              ? error
              : new HerdrTransportError(String(error), transportCode(error)),
          );
        } else if (acknowledged) {
          this.eventDisconnected(error);
        }
      };
      void Bun.connect({
        unix: this.socketPath,
        socket: {
          binaryType: "buffer",
          open: (opened) => {
            socket = opened;
            this.eventSocket = opened;
            opened.write(
              `${JSON.stringify({
                id,
                method: "events.subscribe",
                params: { subscriptions: STATIC_SUBSCRIPTIONS },
              })}\n`,
            );
          },
          data: (_socket, chunk) => {
            buffer += chunk.toString();
            while (true) {
              const newline = buffer.indexOf("\n");
              if (newline < 0) break;
              const raw = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!raw) continue;
              if (!acknowledged) {
                try {
                  const response = JSON.parse(raw) as HerdrResponse<{ type: string }>;
                  if ("error" in response) {
                    fail(new HerdrApiError(response.error.message, response.error.code));
                    return;
                  }
                  if (response.result.type !== "subscription_started") {
                    fail(new HerdrTransportError("bad subscription ack", "EPROTO"));
                    return;
                  }
                  acknowledged = true;
                  settled = true;
                  clearTimeout(timer);
                  resolve();
                } catch (error) {
                  fail(new HerdrTransportError(`invalid subscription ack: ${error}`, "EPROTO"));
                }
                continue;
              }
              this.enqueueLine(raw);
            }
          },
          connectError: (_socket, error) => fail(error),
          error: (_socket, error) => fail(error),
          close: () => fail(new HerdrTransportError("event stream closed", "EOF")),
          end: () => fail(new HerdrTransportError("event stream ended", "EOF")),
        },
      })
        .then((connected) => {
          socket = connected;
        })
        .catch(fail);
    });
  }

  private eventDisconnected(error: unknown): void {
    if (this.stopped) return;
    if (this.eventSocket === null && !this._available) return;
    this.eventSocket = null;
    this._realtime = false;
    this.baselineReady = false;
    this._lastError = error instanceof Error ? error.message : String(error);
    this._generation++;
    this.emit({ kind: "fleet" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatalTransport || this.reconnectTimer) return;
    const base = Math.min(5_000, 250 * 2 ** this.reconnectAttempt++);
    const jitter = 0.8 + this.random() * 0.4;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, Math.round(base * jitter));
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.eventSocket) return;
    try {
      await this.probe(0);
      if (this._readOnly) await this.resync();
      else await this.openSubscriptionAndSnapshot();
    } catch (error) {
      this.markDown(error);
      this.scheduleReconnect();
    }
  }

  private enqueueLine(raw: string): void {
    this.lastEventAt = Date.now();
    if (this.lineQueue.length >= this.queueLimit) {
      this.lineQueue = [];
      this.needsResync = true;
    } else {
      this.lineQueue.push({ raw, replay: !this.baselineReady });
    }
    this.scheduleFlush(this.coalesceMs);
  }

  private scheduleFlush(delay: number): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushQueue();
    }, delay);
    this.flushTimer.unref?.();
  }

  private flushQueue(): void {
    if (!this.baselineReady) return;
    if (this.needsResync) {
      this.needsResync = false;
      void this.resync();
      return;
    }
    const lines = this.lineQueue;
    this.lineQueue = [];
    const paneUpdates = new Map<string, { event: HerdrEvent; replay: boolean }>();
    const flushPaneUpdates = () => {
      for (const item of paneUpdates.values()) this.applyEvent(item.event, item.replay);
      paneUpdates.clear();
    };
    for (const item of lines) {
      let event: HerdrEvent;
      try {
        event = JSON.parse(item.raw) as HerdrEvent;
      } catch {
        this.needsResync = true;
        continue;
      }
      if (event.event === "pane_updated") {
        const pane = event.data.pane as HerdrPane | undefined;
        if (!pane) continue;
        const prior = paneUpdates.get(pane.pane_id)?.event.data.pane as
          | HerdrPane
          | undefined;
        if (!prior || pane.revision > prior.revision) {
          paneUpdates.set(pane.pane_id, { event, replay: item.replay });
        }
      } else {
        // A close/create is an ordering barrier. Applying every coalesced update
        // after the whole batch could resurrect a pane that closed later in the
        // same 200ms window.
        flushPaneUpdates();
        this.applyEvent(event, item.replay);
      }
    }
    flushPaneUpdates();
    if (this.needsResync) {
      this.needsResync = false;
      void this.resync();
    }
  }

  private applyEvent(event: HerdrEvent, replay: boolean): void {
    const data = event.data;
    if (event.event === "pane_updated" || event.event === "pane_created") {
      const pane = data.pane as HerdrPane | undefined;
      if (!pane) return;
      const before = this.panes.get(pane.pane_id);
      if (before && pane.revision <= before.revision) return;
      if (replay && event.event === "pane_created" && !before) return;
      if (event.event === "pane_created") this.closedDuringSnapshot?.delete(pane.pane_id);
      this.panes.set(pane.pane_id, pane);
      if (!before || !sameImportantPaneState(before, pane)) {
        this.bump();
        this.emit({ kind: "pane", pane });
      }
      return;
    }
    if (event.event === "pane_closed") {
      const paneId = data.pane_id;
      if (typeof paneId !== "string") return;
      this.closedDuringSnapshot?.add(paneId);
      const existed = this.panes.delete(paneId);
      if (existed || !replay) {
        this.bump();
        this.emit({ kind: "pane-closed", paneId });
      }
      return;
    }

    const workspace = data.workspace as HerdrWorkspace | undefined;
    // Worktree notifications can contain only IDs. Pull an authoritative snapshot
    // on demand instead of guessing their workspace metadata or waiting 60s.
    if (event.event.startsWith("worktree_") ||
        ((event.event === "workspace_created" || event.event === "workspace_updated" || event.event === "workspace_metadata_updated") && workspace?.worktree === undefined)) {
      this.needsResync = true;
    }
    const tab = data.tab as HerdrTab | undefined;
    const layout = data.layout as HerdrLayout | undefined;
    if (workspace?.workspace_id) this.workspaces.set(workspace.workspace_id, workspace);
    if (tab?.tab_id) this.tabs.set(tab.tab_id, tab);
    if (layout?.tab_id) this.layouts.set(layout.tab_id, layout);
    if (event.event === "workspace_closed" && typeof data.workspace_id === "string") {
      this.workspaces.delete(data.workspace_id);
    }
    if (event.event === "tab_closed" && typeof data.tab_id === "string") {
      this.tabs.delete(data.tab_id);
      this.layouts.delete(data.tab_id);
    }
    this.bump();
    this.emit({ kind: "fleet" });
  }

  private async resync(): Promise<boolean> {
    if (this.stopped || !this._available) return false;
    if (this.snapshotting) return this.snapshotting;
    const closed = new Set<string>();
    this.closedDuringSnapshot = closed;
    this.snapshotting = (async () => {
      try {
        const result = await this.requestWithRetry<HerdrSnapshotResult>(
          "session.snapshot",
          {},
          2,
        );
        this.applySnapshot(result.snapshot, closed);
        return true;
      } catch (error) {
        if (error instanceof HerdrTransportError) this.markDown(error);
        else this._lastError = error instanceof Error ? error.message : String(error);
        return false;
      }
    })().finally(() => {
      this.snapshotting = null;
      this.closedDuringSnapshot = null;
    });
    return this.snapshotting;
  }

  private applySnapshot(snapshot: HerdrSnapshot, closed: ReadonlySet<string>): void {
    this.workspaces.clear();
    this.tabs.clear();
    this.panes.clear();
    this.layouts.clear();
    this.agents.clear();
    for (const workspace of snapshot.workspaces) {
      this.workspaces.set(workspace.workspace_id, workspace);
    }
    for (const tab of snapshot.tabs) this.tabs.set(tab.tab_id, tab);
    // A close already applied while this RPC was in flight is newer than its
    // captured snapshot. Filter before emitting to avoid reviving bindings too.
    for (const pane of snapshot.panes) if (!closed.has(pane.pane_id)) this.panes.set(pane.pane_id, pane);
    for (const layout of snapshot.layouts) this.layouts.set(layout.tab_id, layout);
    for (const agent of snapshot.agents) if (!closed.has(agent.pane_id)) this.agents.set(agent.pane_id, agent);
    this._protocol = snapshot.protocol;
    this._version = snapshot.version;
    this._readOnly = snapshot.protocol !== HERDR_PROTOCOL;
    this._available = true;
    this.lastSnapshotAt = Date.now();
    this.bump();
    this.emit({ kind: "snapshot" });
  }

  private bump(): void {
    this._generation++;
  }

  private emit(change: HerdrClientChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error("[trellis] Herdr listener failed", error);
      }
    }
  }
}
