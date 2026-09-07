import "server-only";
import type { Database } from "bun:sqlite";
import {
  attachHerdrTranscript,
  getHerdrBinding,
  listHerdrBindings,
  markHerdrPaneClosed,
  reconcileHerdrPane,
  reconcileHerdrSnapshot,
} from "./herdr-bindings";
import { HerdrClient } from "./herdr-client";
import type { HerdrPane } from "./herdr-types";

type FleetOptions = {
  db?: Database;
  home?: string;
  attachClaude?: (transcriptPath: string) => void;
  attachTranscript?: (transcriptPath: string, agentKind: string) => void;
};

export class HerdrFleetService {
  private startPromise: Promise<void> | null = null;
  private bindingVersion = 0;
  private readonly attachedTranscriptKeys = new Set<string>();
  private readonly detach: () => void;

  constructor(
    readonly client = new HerdrClient(),
    private readonly options: FleetOptions = {},
  ) {
    this.detach = client.subscribe((change) => {
      const state = client.state;
      if (change.kind === "snapshot") {
        reconcileHerdrSnapshot(state.panes, state.agents, {
          ...this.options,
          attachTranscript: this.attachTranscript,
        });
        this.bindingVersion++;
      } else if (change.kind === "pane") {
        reconcileHerdrPane(
          change.pane,
          state.agents.find((agent) => agent.pane_id === change.pane.pane_id),
          { ...this.options, attachTranscript: this.attachTranscript },
        );
        this.bindingVersion++;
      } else if (change.kind === "pane-closed") {
        markHerdrPaneClosed(change.paneId, this.options.db);
        this.bindingVersion++;
      }
    });
  }

  private readonly attachTranscript = (
    transcriptPath: string,
    agentKind: string,
  ): void => {
    const key = `${agentKind}:${transcriptPath}`;
    if (this.attachedTranscriptKeys.has(key)) return;
    this.attachedTranscriptKeys.add(key);
    if (this.options.attachTranscript) {
      this.options.attachTranscript(transcriptPath, agentKind);
      return;
    }
    if (agentKind === "claude" && this.options.attachClaude) {
      this.options.attachClaude(transcriptPath);
      return;
    }
    void attachHerdrTranscript(transcriptPath, agentKind).catch((error) => {
      this.attachedTranscriptKeys.delete(key);
      console.error("[trellis] failed to attach Herdr transcript", transcriptPath, error);
    });
  };

  ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.client.start().catch((error) => {
        console.error("[trellis] Herdr startup failed", error);
      });
    }
    return this.startPromise;
  }

  stop(): void {
    this.detach();
    this.client.stop();
  }

  fleet(): {
    available: boolean;
    enabled: boolean;
    realtime: boolean;
    readOnly: boolean;
    protocol: number | null;
    version: string | null;
    lastError: string | null;
    workspaces: Record<string, unknown>[];
    sessions: ReturnType<typeof listHerdrBindings>;
  } {
    const state = this.client.state;
    const workspaces = state.workspaces.map((workspace) => ({
      ...workspace,
      tabs: state.tabs
        .filter((tab) => tab.workspace_id === workspace.workspace_id)
        .map((tab) => ({
          ...tab,
          panes: state.panes
            .filter((pane) => pane.tab_id === tab.tab_id)
            .map((pane) => ({
              pane_id: pane.pane_id,
              terminal_id: pane.terminal_id,
              focused: pane.focused,
              agent: pane.agent ?? null,
              agent_status: pane.agent_status,
              agent_session: pane.agent_session ?? null,
              cwd: pane.cwd ?? null,
              label: pane.label ?? null,
              terminal_title: pane.terminal_title ?? null,
              revision: pane.revision,
            })),
          layout: state.layouts.find((layout) => layout.tab_id === tab.tab_id) ?? null,
        })),
    }));
    return {
      available: state.available,
      enabled: state.enabled,
      realtime: state.realtime,
      readOnly: state.readOnly,
      protocol: state.protocol,
      version: state.version,
      lastError: state.lastError,
      workspaces,
      sessions: listHerdrBindings(this.options.db),
    };
  }

  etag(): string {
    return `W/"herdr-${this.client.state.generation}-${this.bindingVersion}"`;
  }

  input(paneId: string, text: string): Promise<Record<string, unknown>> {
    return this.client.enqueueInput(paneId, text);
  }

  keys(paneId: string, keys: string[]): Promise<Record<string, unknown>> {
    return this.client.sendKeys(paneId, keys);
  }

  read(paneId: string): Promise<{ type: "pane_read"; read: { text: string } }> {
    return this.client.request("pane.read", {
      pane_id: paneId,
      source: "recent",
      lines: 200,
    });
  }

  async reopen(sessionId: string): Promise<string> {
    const binding = getHerdrBinding(sessionId, this.options.db);
    if (!binding) throw new Error("Herdr session not found");
    const state = this.client.state;
    const candidates = state.panes.filter((pane) => pane.workspace_id === binding.workspaceId);
    const target =
      candidates.find((pane) => pane.agent == null) ??
      candidates.find((pane) => pane.agent_status === "idle" || pane.agent_status === "done");
    if (!target) throw new Error("Original Herdr workspace has no idle pane; open one in Herdr first");
    return this.client.splitAndResume(
      target as HerdrPane,
      binding.sessionId,
      binding.agentKind,
      binding.cwd ?? target.cwd ?? null,
    );
  }
}

const globalFleet = globalThis as typeof globalThis & {
  __trellisHerdrFleet?: HerdrFleetService;
};

export function getHerdrFleetService(): HerdrFleetService {
  if (!globalFleet.__trellisHerdrFleet) {
    globalFleet.__trellisHerdrFleet = new HerdrFleetService();
  }
  return globalFleet.__trellisHerdrFleet;
}
