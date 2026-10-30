"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, Square, Users } from "lucide-react";
import { Button, Icon, IconButton, Spinner, Tooltip, cn, toast } from "@/components/ui";
import { RoleAvatar } from "@/components/ui/Avatar";
import { COMPOSER_TOOL_ICON, ComposerShell } from "./ComposerShell";
import { useSlashNav } from "@/hooks/useSlashNav";
import { useSessionStore } from "@/stores/sessionStore";
import { isRoundLive, useGroupStore } from "@/stores/groupStore";
import { GROUP_ALL_MENTION, type Group, type GroupRound } from "@/lib/groups";

// 群聊输入框（原型 09-roles.html [data-composer="group"]）：同一副 ComposerShell 外壳，
// 去掉模式 / agent 选择，换成：
//   · @ 菜单：输入「@」或点 @ 按钮弹出「谁来回」（成员 + 所有人），↑↓ / ↩ 选；
//   · 轮次条（beforeCard，贴着输入框）：第几遍（分段）、x / 10 条、接下来是谁、停下这一轮；
//   · 一轮在进行时发送按钮换成停止（服务端一次只跑一轮，发不进去）。

type AtItem = { kind: "member"; roleId: string; name: string; sub: string; hue: number; glyph: string } | { kind: "all" };

/** 光标前面正在输入的 @ 词：`@`、`@老`… 返回 { start, query }；不在 @ 词里 = null。 */
function atTokenBefore(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(（])@([^\s@]{0,20})$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

function RoundBar({ group, round }: { group: Group; round: GroupRound }) {
  const stop = useGroupStore((s) => s.stop);
  // 换了一轮就是新的 RoundBar（调用方按 round.id 给 key），「停下中…」不会带到下一轮。
  const [stopping, setStopping] = useState(false);
  const next = round.queued
    .map((id) => group.members.find((m) => m.roleId === id)?.name)
    .filter(Boolean)
    .slice(0, 3);
  return (
    <div
      data-group-round
      role="status"
      className="mb-2 flex items-center gap-2.5 rounded-full bg-surface py-1.5 pr-2 pl-3 text-label text-ink-muted shadow-raise max-md:mx-0.5"
    >
      <span className="shrink-0">本轮</span>
      <span className="inline-flex shrink-0 gap-[3px]" title={`来回 ${round.maxPasses} 遍`} aria-hidden>
        {Array.from({ length: round.maxPasses }, (_, i) => (
          <i key={i} className={cn("block h-1 w-3.5 rounded-full", i < round.pass ? "bg-accent" : "bg-line-strong")} />
        ))}
      </span>
      <span className="shrink-0 tabular-nums">
        第 {round.pass} 遍 · {round.messages} / {round.maxMessages} 条
      </span>
      {next.length > 0 && <span className="min-w-0 truncate text-ink-faint max-md:hidden">接下来：{next.join("、")}</span>}
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        data-group-stop
        disabled={stopping}
        onClick={() => {
          setStopping(true);
          void stop(group.id);
        }}
        className="shrink-0"
      >
        {stopping ? "停下中…" : "停下这一轮"}
      </Button>
    </div>
  );
}

export function GroupComposer({
  group,
  mobileCompact = false,
  onMobileExpandedChange,
}: {
  group: Group;
  mobileCompact?: boolean;
  onMobileExpandedChange?: (expanded: boolean) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [atDismissed, setAtDismissed] = useState<number | null>(null);
  const sendKey = useSessionStore((s) => s.sendKey);
  const provider = useSessionStore((s) => s.provider);
  const round = useGroupStore((s) => s.rounds[group.id] ?? null);
  const send = useGroupStore((s) => s.send);
  const stop = useGroupStore((s) => s.stop);
  const live = isRoundLive(round);

  useEffect(() => {
    onMobileExpandedChange?.(mobileCompact && mobileExpanded);
  }, [mobileCompact, mobileExpanded, onMobileExpandedChange]);

  const token = atTokenBefore(text, caret);
  const menuOpen = !!token && atDismissed !== token.start;
  const items: AtItem[] = useMemo(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    const members: AtItem[] = group.members
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .map((m) => ({
        kind: "member",
        roleId: m.roleId,
        name: m.name,
        sub: m.intro.split(/[。，,.；;\n]/)[0] ?? "",
        hue: m.avatarHue,
        glyph: m.avatarGlyph,
      }));
    const all: AtItem[] = !q || GROUP_ALL_MENTION.includes(q) || "all".startsWith(q) ? [{ kind: "all" }] : [];
    return [...members, ...all];
  }, [token, group.members]);

  const pick = (i: number) => {
    const it = items[i];
    if (!it || !token) return;
    const name = it.kind === "all" ? GROUP_ALL_MENTION : it.name;
    const next = `${text.slice(0, token.start)}@${name} ${text.slice(caret)}`;
    const pos = token.start + name.length + 2;
    setText(next);
    setCaret(pos);
    window.requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };
  const nav = useSlashNav(menuOpen ? items.length : 0, token?.query ?? "", pick);

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? text.length);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending || live) return;
    setSending(true);
    const err = await send(group.id, t, provider);
    setSending(false);
    if (err) {
      toast.error(err);
      return;
    }
    setText("");
    setCaret(0);
    if (mobileCompact) setMobileExpanded(false);
  };

  const insertAt = () => {
    const el = ref.current;
    const pos = el?.selectionStart ?? text.length;
    const needSpace = pos > 0 && !/\s$/.test(text.slice(0, pos));
    const next = `${text.slice(0, pos)}${needSpace ? " " : ""}@${text.slice(pos)}`;
    const np = pos + (needSpace ? 2 : 1);
    setText(next);
    setCaret(np);
    setAtDismissed(null);
    window.requestAnimationFrame(() => {
      if (mobileCompact) setMobileExpanded(true);
      ref.current?.focus();
      ref.current?.setSelectionRange(np, np);
    });
  };

  const atButton = (
    <IconButton label="@ 角色" title="@ 指定谁来回" onClick={insertAt} data-group-at-btn className={COMPOSER_TOOL_ICON}>
      <Icon icon={AtSign} />
    </IconButton>
  );

  const primary = live ? (
    <Tooltip content="停下这一轮" side="top">
      <Button
        variant="ink"
        size="icon"
        aria-label="停下这一轮"
        data-composer-primary="stop"
        onClick={() => void stop(group.id)}
        className="shrink-0 rounded-full! md:min-h-7.5 md:min-w-7.5"
      >
        <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden />
      </Button>
    </Tooltip>
  ) : (
    <Tooltip content="发送到群里" shortcut={sendKey === "enter" ? "↩" : ["⌘", "↩"]} side="top">
      <Button
        variant="ink"
        size="icon"
        aria-label="发送到群里"
        data-composer-primary={sending ? "loading" : "send"}
        data-group-send
        onClick={() => void submit()}
        disabled={!text.trim() || sending}
        className="shrink-0 rounded-full! md:min-h-7.5 md:min-w-7.5"
      >
        {sending ? <Spinner size="sm" label={null} className="text-current" /> : <Icon icon={ArrowUp} size="md" selected />}
      </Button>
    </Tooltip>
  );

  const menu = menuOpen && items.length > 0 && (
    <div
      data-group-at-menu
      role="listbox"
      aria-label="谁来回"
      className="absolute bottom-[calc(100%-0.25rem)] left-2 z-30 w-72 max-w-[calc(100%-1rem)] rounded-card bg-surface-raised p-1 shadow-pop"
    >
      <div className="px-2 pt-1.5 pb-1 text-[11.5px] text-ink-faint">谁来回</div>
      {items.map((it, i) => (
        <button
          key={it.kind === "all" ? "__all" : it.roleId}
          type="button"
          role="option"
          aria-selected={i === nav.active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(i)}
          className={cn(
            "flex h-9.5 w-full items-center gap-2.5 rounded-[7px] px-2 text-left max-md:h-11",
            i === nav.active ? "bg-surface-hover" : "hover:bg-surface-hover",
          )}
        >
          {it.kind === "all" ? (
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-muted text-ink-muted shadow-hairline">
              <Icon icon={Users} size="sm" className="size-3" />
            </span>
          ) : (
            <RoleAvatar role={{ avatarHue: it.hue, avatarGlyph: it.glyph, name: it.name }} size="sm" />
          )}
          <span className="min-w-0 truncate text-ui font-medium text-ink">{it.kind === "all" ? "所有人" : it.name}</span>
          <span className="ml-auto shrink-0 truncate pl-2 text-label text-ink-faint">
            {it.kind === "all" ? "每位都回" : it.sub}
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <ComposerShell
      textareaRef={ref}
      value={text}
      onValueChange={(v) => {
        setText(v);
        window.requestAnimationFrame(syncCaret);
      }}
      onSubmit={() => void submit()}
      onEscape={menuOpen ? () => setAtDismissed(token?.start ?? null) : undefined}
      sendKey={sendKey}
      onSlashKeyDown={nav.handleKeyDown}
      suggestions={menu}
      disabled={false}
      placeholder={live ? "这一轮还在说，停下后再发" : "说点什么，@ 指定谁来回"}
      compactPlaceholder="说点什么…"
      mobileCompact={mobileCompact}
      mobileExpanded={mobileExpanded}
      onMobileExpandedChange={setMobileExpanded}
      keepExpanded={Boolean(text.trim())}
      tools={atButton}
      compactTools={atButton}
      primary={primary}
      state={live ? "stopping" : mobileCompact && !mobileExpanded ? "compact" : "expanded"}
      beforeCard={live && round ? <RoundBar key={round.id} group={group} round={round} /> : undefined}
      rootProps={{ "data-group-composer": group.id }}
      textareaProps={{
        "aria-label": "群聊输入框",
        // 光标移动（点击 / 方向键）也要更新 @ 词判断
        ...({ onSelect: syncCaret, onClick: syncCaret, onKeyUp: syncCaret } as object),
      }}
    />
  );
}
