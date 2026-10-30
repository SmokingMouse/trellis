"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowRightLeft, ExternalLink, Settings2, X } from "lucide-react";
import { Button, Icon, IconButton, Modal, Select, Spinner, StatusDot, type SelectOption } from "@/components/ui";
import { refreshHubNodes, relayTargetsOf, useHubNodes } from "@/hooks/useHubNodes";
import {
  fetchRemoteWorkspaces,
  relaySession,
  RelayClientError,
  type RelayOutcome,
  type RemoteWorkspace,
} from "@/lib/session-relay-client";
import type { ChatNode, Session } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";
import { visibleThreadLeafId } from "./LinearThreadView";

// 会话接力弹窗：把当前机器上的一段对话复制到 hub 上的另一台机器接着聊。
// 入口：顶栏「更多」、手机溢出菜单、侧栏会话行菜单 —— 都只调 openRelayDialog()，
// 弹窗本体由 <RelaySessionHost/>（app/page.tsx）常驻挂一份。
// 流程：viaFetch(当前机器, /api/export/session/<id>) → viaFetch(目标, /api/import/session)
// → 成功后「打开」整页跳 goHref(目标, 会话路径)。格式与边界见 lib/session-relay.ts。

export type RelayDialogTarget = {
  sessionId: string;
  title: string;
  /** 接力到哪个节点为止（当前看着的分支叶节点）；null = 服务端取最近节点。 */
  nodeId: string | null;
  /** 链上的轮数（已知时写进确认文案）。 */
  turns: number | null;
  /** 源会话工作区目录名：目标机器上有同名工作区就默认选它。 */
  workspaceName: string | null;
};

let openTarget: RelayDialogTarget | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function openRelayDialog(target: RelayDialogTarget): void {
  openTarget = target;
  void refreshHubNodes();
  emit();
}

function basename(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

/**
 * 给某个会话打开接力弹窗。是当前打开的会话 → 接力到正在看的那条分支的叶节点（并算出轮数）；
 * 否则（侧栏里别的会话）交给服务端取最近节点。
 */
export function openRelayForSession(session: Pick<Session, "id" | "title" | "workspacePath">): void {
  const st = useSessionStore.getState();
  let nodeId: string | null = null;
  let turns: number | null = null;
  if (st.session?.id === session.id) {
    nodeId = visibleThreadLeafId(st.nodes, st.activeNodeId, st.session.rootNodeId);
    if (nodeId) {
      turns = 0;
      for (
        let cur: ChatNode | undefined = st.nodes[nodeId];
        cur && turns < 5000;
        cur = cur.parentId ? st.nodes[cur.parentId] : undefined
      ) {
        turns++;
      }
    }
  }
  openRelayDialog({
    sessionId: session.id,
    title: session.title,
    nodeId,
    turns,
    workspaceName: basename(session.workspacePath),
  });
}

function closeRelayDialog() {
  openTarget = null;
  emit();
}

export function RelaySessionHost() {
  const target = useSyncExternalStore(subscribe, () => openTarget, () => null);
  if (!target) return null;
  return <RelaySessionDialog key={`${target.sessionId}:${target.nodeId ?? ""}`} target={target} onClose={closeRelayDialog} />;
}

const CHAT_ONLY = "__chat__";

type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; to: string; outcome: RelayOutcome }
  | { kind: "error"; message: string; blockedByPolicy: boolean };

function RelaySessionDialog({ target, onClose }: { target: RelayDialogTarget; onClose: () => void }) {
  const list = useHubNodes();
  const { current, others } = relayTargetsOf(list);
  const [picked, setPicked] = useState<string | null>(null);
  const to = picked && others.some((n) => n.name === picked) ? picked : (others[0]?.name ?? null);
  const [workspaces, setWorkspaces] = useState<{ node: string; list: RemoteWorkspace[] } | null>(null);
  const [workspaceChoice, setWorkspaceChoice] = useState<{ node: string; value: string } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const shareOutBlocked = !!current && !current.policy.shareOut;

  // 选中目标机器后拉它最近的工作区（给「以 project 模式接着干」选目录）。
  useEffect(() => {
    if (!to || shareOutBlocked) return;
    let cancelled = false;
    void fetchRemoteWorkspaces(to).then((ws) => {
      if (!cancelled) setWorkspaces({ node: to, list: ws });
    });
    return () => {
      cancelled = true;
    };
  }, [to, shareOutBlocked]);

  const remoteWs = workspaces && workspaces.node === to ? workspaces.list : null;
  const workspaceOptions = useMemo<SelectOption[]>(
    () => [
      { value: CHAT_ONLY, label: "不绑定工作区（纯对话）" },
      ...(remoteWs ?? []).map((w) => ({ value: w.path, label: w.shortName, description: w.path })),
    ],
    [remoteWs],
  );
  // 默认：目标机器上有和源会话同名的工作区就选它，否则纯对话。
  const defaultWorkspace =
    (target.workspaceName && remoteWs?.find((w) => w.shortName === target.workspaceName)?.path) || CHAT_ONLY;
  const workspaceValue = workspaceChoice && workspaceChoice.node === to ? workspaceChoice.value : defaultWorkspace;

  const run = async () => {
    if (!current || !to) return;
    setPhase({ kind: "running" });
    try {
      const outcome = await relaySession({
        from: current.name,
        to,
        sessionId: target.sessionId,
        nodeId: target.nodeId,
        workspacePath: workspaceValue === CHAT_ONLY ? null : workspaceValue,
      });
      setPhase({ kind: "done", to, outcome });
    } catch (e) {
      const blocked = e instanceof RelayClientError && e.step === "export" && e.status === 403;
      const message =
        e instanceof RelayClientError
          ? `${e.step === "export" ? `从 ${current.name} 导出失败` : `在 ${to} 上导入失败`}：${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      setPhase({ kind: "error", message, blockedByPolicy: blocked });
    }
  };

  const goSettings = () => {
    window.location.href = "/settings/nodes";
  };

  const turnsText = target.turns ? `这段对话（${target.turns} 轮）` : "这段对话";

  return (
    <Modal onClose={onClose} size="md" title="接力到其他机器" panelClassName="flex max-h-[85vh] flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={ArrowRightLeft} size="sm" className="text-ink-faint" />
          <h2 className="truncate text-ui font-semibold text-ink-strong">接力到其他机器</h2>
        </div>
        <IconButton label="关闭" size="sm" onClick={onClose}>
          <Icon icon={X} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-ui text-ink">
        <p className="truncate text-label text-ink-muted" title={target.title}>
          会话：<span className="text-ink">{target.title}</span>
        </p>

        {!list ? (
          <div className="flex items-center gap-2 text-label text-ink-faint">
            <Spinner size="sm" /> 正在读取机器列表…
          </div>
        ) : !current || others.length === 0 ? (
          <p className="text-label text-ink-muted">hub 上暂时没有别的在线机器可以接力。</p>
        ) : shareOutBlocked ? (
          <div role="alert" className="space-y-3 rounded-field border border-warn-line bg-warn-muted px-3 py-3 text-label text-warn-ink">
            <p>
              本机（{current.name}）关闭了「允许内容离开这台机器」，对话不能被带到别的机器上。
              这通常是有意的：公司 devbox 上的代码和上下文默认不外流。
            </p>
            <p>确实要接力，先在 设置 → 机器互联 里给 {current.name} 打开这个开关。</p>
            <Button size="sm" onClick={goSettings}>
              <Icon icon={Settings2} size="sm" /> 去设置 → 机器互联
            </Button>
          </div>
        ) : phase.kind === "done" ? (
          <div className="space-y-2">
            <p>
              已在 <span className="font-medium">{phase.to}</span> 上建好「{phase.outcome.title}」
              {phase.outcome.mode === "project" ? "（project 模式）" : "（纯对话）"}。
            </p>
            <p className="text-label text-ink-faint">本机的原会话保持不变。</p>
          </div>
        ) : (
          <>
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-label font-medium text-ink-muted">目标机器</legend>
              {others.map((n) => (
                <label
                  key={n.name}
                  className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-field border border-line px-3 py-2 hover:bg-surface-hover has-[:checked]:border-accent has-[:checked]:bg-accent-muted max-md:min-h-11"
                >
                  <input
                    type="radio"
                    name="relay-target"
                    value={n.name}
                    checked={to === n.name}
                    onChange={() => setPicked(n.name)}
                    className="accent-accent"
                  />
                  <StatusDot tone="positive" />
                  <span className="font-medium">{n.name}</span>
                  <span className="ml-auto text-label text-ink-faint">
                    {n.kind === "home" ? "hub 本机" : "远端"}
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="space-y-1.5">
              <label htmlFor="relay-workspace" className="block text-label font-medium text-ink-muted">
                在 {to} 上用哪个工作区接着聊
              </label>
              <Select
                id="relay-workspace"
                aria-label="目标工作区"
                value={workspaceValue}
                onValueChange={(v) => to && setWorkspaceChoice({ node: to, value: v })}
                options={workspaceOptions}
                className="w-full"
              />
              {remoteWs === null && <p className="text-label text-ink-faint">正在读取 {to} 的工作区…</p>}
            </div>

            <div className="rounded-field bg-surface-muted px-3 py-2.5 text-label leading-relaxed text-ink-muted">
              会把{turnsText}的文字内容复制到 <span className="font-medium text-ink">{to}</span>
              ：每一轮的提问、回答和工具调用摘要。附件、工作区文件、树上的其他分支不会带过去；本机的原会话保持不变。
            </div>

            {phase.kind === "error" && (
              <div role="alert" className="space-y-2 rounded-field border border-danger-line bg-danger-muted px-3 py-2.5 text-label text-danger-ink">
                <p>{phase.message}</p>
                {phase.blockedByPolicy && (
                  <Button size="sm" onClick={goSettings}>
                    <Icon icon={Settings2} size="sm" /> 去设置 → 机器互联
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface px-4 py-3">
        {phase.kind === "done" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              留在这里
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                window.location.href = phase.outcome.openHref;
              }}
            >
              <Icon icon={ExternalLink} size="sm" /> 打开
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={phase.kind === "running"}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void run()}
              loading={phase.kind === "running"}
              disabled={!current || !to || shareOutBlocked || phase.kind === "running"}
            >
              {to ? `接力到 ${to}` : "接力"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
