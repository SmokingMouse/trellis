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
import type { HerdrInputDelivery } from "../herdr-input";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getDB } from "./sqlite";
import type { HerdrWorktree } from "../herdr-ui";

function canonicalPath(value: string): string {
  try { return realpathSync(value); } catch { return value; }
}

type FleetOptions = {
  db?: Database;
  home?: string;
  attachClaude?: (transcriptPath: string) => void;
  attachTranscript?: (transcriptPath: string, agentKind: string) => void;
};

export class HerdrFleetService {
  private startPromise: Promise<void> | null = null;
  private bindingVersion = 0;
  private worktrees = new Map<string, HerdrWorktree>();
  private worktreeSignature = "";
  private readonly attachedTranscriptKeys = new Set<string>();
  private readonly detach: () => void;

  constructor(
    readonly client = new HerdrClient(),
    private readonly options: FleetOptions = {},
  ) {
    this.detach = client.subscribe((change) => {
      const state = client.state;
      if (change.kind === "snapshot") {
        this.reconcileWorktrees();
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
      } else if (change.kind === "fleet" && this.metadataSignature() !== this.worktreeSignature) {
        this.reconcileWorktrees();
      }
    });
  }

  private metadataSignature(): string {
    return JSON.stringify(this.client.state.workspaces.map(w => [w.workspace_id, w.worktree]));
  }

  private reconcileWorktrees(): void {
    this.worktreeSignature = this.metadataSignature();
    const metadata = this.client.state.workspaces.filter(w => w.worktree?.repo_root && w.worktree.checkout_path);
    const next = new Map<string, HerdrWorktree>();
    if (metadata.length) {
      const db = this.options.db ?? getDB();
      const branches = new Map<string, string>();
      const projectNames = new Map<string, string>();
      // Older isolated databases may not have the project/workspace schema.
      if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").get()) {
        const rows = db.query("SELECT path, git_branch FROM workspaces WHERE git_branch IS NOT NULL").all() as { path: string; git_branch: string }[];
        for (const row of rows) branches.set(canonicalPath(row.path), row.git_branch);
        if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()) {
          const names = db.query("SELECT w.path, p.name FROM workspaces w JOIN projects p ON p.id = w.project_id").all() as { path: string; name: string }[];
          for (const row of names) projectNames.set(canonicalPath(row.path), row.name);
        }
      }
      const resolved = new Map<string, string | null>();
      for (const workspace of metadata) {
        const wt = workspace.worktree!;
        const checkout = canonicalPath(wt.checkout_path);
        if (!resolved.has(checkout)) {
          let branch = branches.get(checkout) || null;
          if (!branch) {
            try { branch = execFileSync("git", ["-C", checkout, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* missing checkout or git */ }
          }
          resolved.set(checkout, branch);
        }
        const root = canonicalPath(wt.repo_root);
        next.set(workspace.workspace_id, { ...wt, repo_root: root, repo_name: projectNames.get(root) || wt.repo_name, checkout_path: checkout, git_branch: resolved.get(checkout) });
      }
    }
    // Workspace events refresh structure immediately; pane events do not resolve branches.
    this.worktrees = next;
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
    inputDeliveries: HerdrInputDelivery[];
  } {
    const state = this.client.state;
    const workspaces = state.workspaces.map((workspace) => ({
      ...workspace,
      worktree: this.worktrees.get(workspace.workspace_id) ?? null,
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
      inputDeliveries: this.client.inputDeliveries,
    };
  }

  etag(): string {
    return `W/"herdr-${this.client.state.generation}-${this.bindingVersion}"`;
  }

  input(paneId: string, text: string): Promise<HerdrInputDelivery> {
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
