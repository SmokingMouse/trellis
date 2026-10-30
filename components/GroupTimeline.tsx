"use client";
import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { CirclePause, Reply, TriangleAlert } from "lucide-react";
import { Button, Icon, PixelLoader, toast } from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { MarkdownBody } from "@/lib/markdown-cache";
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_STREAMING_REHYPE_PLUGINS } from "@/lib/markdown-plugins";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "@/lib/md-components";
import { MarkdownStreamingContext } from "@/lib/markdown-streaming";
import { getStreamPending, subscribeStream } from "@/lib/stream-bus";
import { clockLabel } from "@/lib/role-timeline";
import {
  GROUP_ALL_MENTION,
  buildButlerTaskDraft,
  groupNodeMeta,
  isSkipReply,
  type Group,
  type GroupMember,
  type GroupRound,
} from "@/lib/groups";
import type { ChatNode } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";
import { isRoundLive, useGroupStore } from "@/stores/groupStore";
import { useComposerInsertStore } from "@/stores/composerInsertStore";
import { ToolTimeline } from "./tools/ToolTimeline";
import { InteractionForm } from "./InteractionForm";

// 群聊时间线的各件（原型 09-roles.html s-group / s-group-limit）：
//   用户消息（右侧浅灰气泡，@ 高亮）、角色发言（头像 + 名字 + 介绍 + 时间，引用回复 quote，
//   流式时同普通回答一样实时渲染 markdown）、「X 在想…」、上限卡（继续讨论 / 让管家记成任务）。
// LinearThreadView 在群会话里把每个节点交给 GroupMessage，外壳（滚动、输入框停靠、键盘）照旧复用。

/** 群节点里哪些要画：跳过的发言、空的系统节点不画。 */
export function isVisibleGroupNode(node: ChatNode): boolean {
  const meta = groupNodeMeta(node.meta);
  if (!meta) return true;
  if (meta.kind === "group-reply" && meta.skipped) return false;
  return true;
}

/** 用户消息里的 @名字 / @所有人 标成 mention 色块。 */
function highlightMentions(text: string, members: GroupMember[]): ReactNode[] {
  const names = [GROUP_ALL_MENTION, ...members.map((m) => m.name)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@") {
      const rest = text.slice(i + 1).toLowerCase();
      const hit = names.find((n) => rest.startsWith(n.toLowerCase()));
      if (hit) {
        if (buf) out.push(buf);
        buf = "";
        out.push(
          <span key={i} className="rounded-[4px] bg-accent-muted px-1 font-medium text-accent-ink">
            @{text.slice(i + 1, i + 1 + hit.length)}
          </span>,
        );
        i += hit.length + 1;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  if (buf) out.push(buf);
  return out;
}

function UserMessage({ node, members }: { node: ChatNode; members: GroupMember[] }) {
  return (
    <div data-group-user-msg className="mb-5 flex justify-end">
      <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-[14px_14px_4px_14px] bg-surface-muted px-3.5 py-2.5 text-reading leading-[1.6] text-ink shadow-hairline">
        {highlightMentions(node.question, members)}
      </div>
    </div>
  );
}

/** 流式正文：同 TurnCard.ResponseBody 的 rAF 合帧订阅。 */
function useLiveText(node: ChatNode): string {
  const streaming = node.status === "streaming";
  const [live, setLive] = useState("");
  useEffect(() => {
    if (!streaming) return;
    let buf = node.response + getStreamPending(node.id);
    const flush = () => {
      raf = 0;
      setLive(buf);
    };
    // 首帧也走 rAF（别在 effect 里同步 setState）；那一帧由下面的 render 兜底现算。
    let raf = requestAnimationFrame(flush);
    const unsub = subscribeStream(node.id, (delta) => {
      buf += delta;
      if (!raf) raf = requestAnimationFrame(flush);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, node.id]);
  if (!streaming) return node.response;
  return live || node.response + getStreamPending(node.id);
}

/** 「X 在想…」一行（原型 .typing）。 */
export function GroupTypingRow({ member, label }: { member: GroupMember | null; label?: string }) {
  return (
    <div data-group-typing className="mb-5 flex items-center gap-2.5 text-ui text-ink-muted" role="status">
      {member ? (
        <RoleAvatar role={member} size="sm" />
      ) : (
        <span className="size-6 shrink-0 rounded-full bg-surface-muted shadow-hairline" aria-hidden />
      )}
      <PixelLoader size="sm" label={null} />
      <span className="shimmer-text font-medium">{label ?? `${member?.name ?? "有人"} 在想…`}</span>
    </div>
  );
}

function ReplyMessage({ node, member, optional }: { node: ChatNode; member: GroupMember | null; optional: boolean }) {
  const meta = groupNodeMeta(node.meta);
  const text = useLiveText(node);
  const streaming = node.status === "streaming";
  const name = member?.name ?? "已退群的角色";
  // 还没吐字 / 可能在吐「（跳过）」：只显示「在想…」，免得闪一下半截的（跳
  if (streaming && (!text.trim() || (optional && isSkipReply(text, true))) && node.toolCalls.length === 0) {
    return <GroupTypingRow member={member} />;
  }
  const replyTo = meta?.kind === "group-reply" ? meta.replyTo : null;
  const aborted = node.status === "error" && node.errorMessage === "aborted";
  return (
    <div data-group-reply={member?.roleId ?? ""} data-node-id={node.id} className="mb-5.5 flex gap-3">
      {member ? (
        <RoleAvatar role={member} size="md" />
      ) : (
        <span className="size-7 shrink-0 rounded-full bg-surface-muted shadow-hairline" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-baseline gap-2">
          <span className="text-[13.5px] font-semibold text-ink">{name}</span>
          {member?.intro && (
            <span className="min-w-0 truncate text-[11.5px] text-ink-faint">{member.intro.split(/[。，,.；;\n]/)[0]}</span>
          )}
          <span className="shrink-0 text-[11.5px] tabular-nums text-ink-faint">{clockLabel(node.createdAt)}</span>
        </div>
        {replyTo && (
          <span
            data-group-quote
            className="mt-0.5 mb-2 inline-flex max-w-full items-center gap-1.5 rounded-chip bg-surface-muted py-1 pr-2.5 pl-2 text-label text-ink-muted shadow-hairline"
          >
            <Icon icon={Reply} size="sm" className="size-3 shrink-0" />
            <span className="truncate">
              回复 {replyTo.name}：{replyTo.excerpt}
            </span>
          </span>
        )}
        {node.toolCalls.length > 0 || (node.toolCallStats?.total ?? 0) > 0 ? (
          <div className="mb-1.5">
            <ToolTimeline nodeId={node.id} toolCalls={node.toolCalls} stats={node.toolCallStats ?? null} live={streaming} />
          </div>
        ) : null}
        <div className="md-body text-reading leading-[1.7] text-ink [&_p:last-child]:mb-0">
          {streaming ? (
            <MarkdownStreamingContext.Provider value>
              <ReactMarkdown
                remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                rehypePlugins={MARKDOWN_STREAMING_REHYPE_PLUGINS}
                components={MD_COMPONENTS}
                urlTransform={MD_URL_TRANSFORM}
              >
                {text}
              </ReactMarkdown>
            </MarkdownStreamingContext.Provider>
          ) : text ? (
            <MarkdownBody cacheKey={node.id} content={text} />
          ) : null}
        </div>
        {node.pendingInteraction && <InteractionForm nodeId={node.id} interaction={node.pendingInteraction} />}
        {aborted ? (
          <div className="mt-1 text-label text-ink-faint">停下了</div>
        ) : node.status === "error" ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-label text-danger-ink">
            <Icon icon={TriangleAlert} size="sm" />
            <span className="min-w-0 truncate" title={node.errorMessage ?? undefined}>
              这条没说完：{node.errorMessage ?? "出错了"}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 开管家并把这一轮的讨论预填进它的输入框（不替你发）。 */
async function openButlerWithDraft(draft: string) {
  let sessionId: string | null = null;
  try {
    const res = await fetch("/api/butler/session", { cache: "no-store" });
    if (res.ok) sessionId = ((await res.json()) as { sessionId: string | null }).sessionId;
  } catch {
    /* 查不到就当没有：落管家草稿首页 */
  }
  // 草稿首页（还没有管家会话）用固定键，ButlerHome 认它。
  useComposerInsertStore.getState().queueComposerInsert(sessionId ?? "butler-draft", draft);
  await useSessionStore.getState().openButler();
}

const BUTLER_AVATAR = { avatarHue: 255, avatarGlyph: "管", name: "管家" };

function LimitCard({ node, group, isLatest }: { node: ChatNode; group: Group | null; isLatest: boolean }) {
  const round = useGroupStore((s) => (group ? s.rounds[group.id] : null));
  const continueRound = useGroupStore((s) => s.continueRound);
  const provider = useSessionStore((s) => s.provider);
  const [busy, setBusy] = useState(false);
  const live = isRoundLive(round);

  const toButler = () => {
    if (!group) return;
    // 这一轮 = 上限卡之前、最近一条用户消息之后（含）的所有可见发言。
    const nodes = Object.values(useSessionStore.getState().nodes).sort((a, b) => a.createdAt - b.createdAt);
    const end = nodes.findIndex((n) => n.id === node.id);
    let start = end;
    while (start > 0 && groupNodeMeta(nodes[start - 1].meta)?.kind !== "group-user") start--;
    if (start > 0) start--;
    const lines = nodes
      .slice(Math.max(0, start), end)
      .filter(isVisibleGroupNode)
      .flatMap((n) => {
        const m = groupNodeMeta(n.meta);
        if (m?.kind === "group-user") return [{ name: "我", text: n.question }];
        if (m?.kind === "group-reply") {
          const who = group.members.find((x) => x.roleId === m.roleId)?.name ?? "角色";
          return n.response.trim() ? [{ name: who, text: n.response }] : [];
        }
        return [];
      });
    void openButlerWithDraft(buildButlerTaskDraft(group.name, lines));
  };

  return (
    <div
      data-group-limit
      className="mb-5.5 flex flex-wrap items-center gap-2.5 rounded-card bg-surface-muted px-3.5 py-3 text-ui text-ink-muted shadow-hairline md:ml-10"
    >
      <Icon icon={CirclePause} size="sm" className="shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1">{node.question}</span>
      <span className="flex shrink-0 items-center gap-2 max-md:w-full max-md:justify-end">
        <Button
          size="sm"
          variant="secondary"
          disabled={!group || !isLatest || live || busy}
          title={isLatest ? undefined : "后面已经接着聊了"}
          onClick={async () => {
            if (!group) return;
            setBusy(true);
            const err = await continueRound(group.id, provider);
            setBusy(false);
            if (err) toast.error(err);
          }}
        >
          继续讨论
        </Button>
        <Button size="sm" variant="primary" disabled={!group} onClick={toButler}>
          <RoleAvatar role={BUTLER_AVATAR} size="xs" />
          让管家记成任务
        </Button>
      </span>
    </div>
  );
}

/** 一个群节点 → 对应的件。 */
export const GroupMessage = memo(function GroupMessage({
  node,
  group,
  isLatest,
}: {
  node: ChatNode;
  group: Group | null;
  /** 是不是时间线上最后一个节点（上限卡只有在最后时能「继续讨论」） */
  isLatest: boolean;
}) {
  const meta = groupNodeMeta(node.meta);
  const members = group?.members ?? [];
  if (meta?.kind === "group-round-end") return <LimitCard node={node} group={group} isLatest={isLatest} />;
  if (meta?.kind === "group-reply") {
    const member = members.find((m) => m.roleId === meta.roleId) ?? null;
    const optional = group?.settings.replyPolicy === "all";
    return <ReplyMessage node={node} member={member} optional={optional} />;
  }
  // group-user 与（理论上不会有的）普通节点都按用户消息画
  return <UserMessage node={node} members={members} />;
});

/** 时间线末尾：路由在挑人时「正在挑一位来回…」；当前发言者的节点还没到时先画「X 在想…」。 */
export function GroupRoundTail({ group, round, nodes }: { group: Group | null; round: GroupRound | null; nodes: Record<string, ChatNode> }) {
  if (!group || !isRoundLive(round)) return null;
  if (round.status === "routing") return <GroupTypingRow member={null} label="正在挑一位来回…" />;
  const cur = round.current;
  if (!cur || (cur.nodeId && nodes[cur.nodeId])) return null;
  const member = group.members.find((m) => m.roleId === cur.roleId) ?? null;
  return <GroupTypingRow member={member} />;
}

/** 打开群聊时把已完成的发言标已读（群里没有逐卡阅读的概念，看到了就算读了）。 */
export function useMarkGroupRead(enabled: boolean, nodes: Record<string, ChatNode>) {
  const markNodeRead = useSessionStore((s) => s.markNodeRead);
  useEffect(() => {
    if (!enabled) return;
    for (const n of Object.values(nodes)) {
      if (n.status === "done" && !n.readAt) void markNodeRead(n.id);
    }
  }, [enabled, nodes, markNodeRead]);
}

