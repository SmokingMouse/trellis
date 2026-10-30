"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent } from "react";
import { Anchor, ArrowUp, Cpu, Paperclip, Square } from "lucide-react";
import { Button, Icon, IconButton, Spinner, Tooltip } from "@/components/ui";
import { COMPOSER_TOOL_ICON, ComposerShell, type ComposerQueueItem } from "./ComposerShell";
import { SkillPickerList } from "./SkillPickerList";
import { uploadAttachment } from "./AttachmentPreview";
import { useSessionStore } from "@/stores/sessionStore";
import { refreshHerdrFleet, useHerdrFleet } from "@/hooks/useHerdrFleet";
import { useHerdrConsole } from "@/hooks/useHerdrConsole";
import { useSlashNav } from "@/hooks/useSlashNav";
import { useHerdrReopen } from "@/hooks/useHerdrReopen";
import { HerdrActionError, cancelHerdrInput, newClientMsgId, sendHerdrInput, sendHerdrKeys } from "@/lib/herdr-actions";
import { newOutboxItem, outboxFor, type OutboxItem } from "@/lib/outbox";
import { outbox, outboxFailure } from "@/lib/outbox-client";
import { HerdrInteractionCard } from "./HerdrInteractionCard";
import { herdrSendTarget } from "@/lib/herdr-mode";
import type { HerdrPaneView } from "@/lib/herdr-ui";
import {
  CLAUDE_BUILTIN_COMMANDS,
  CLAUDE_SLASH_KIND_LABEL,
  matchClaudeCommands,
  type ClaudeSlashCommand,
} from "@/lib/claude-commands";
import {
  herdrComposerHint,
  insertPathAt,
  adoptServerQueue,
  reconcileHerdrQueue,
  restoreDraft,
  type HerdrQueuedInput,
} from "@/lib/herdr-composer";
import { classifyFile, acceptFor } from "@/lib/attachments";

// Herdr 会话的输入框：与常规 Composer 同一副外壳（ComposerShell），内容换成 Herdr 语义。
//   - 发送键与常规一致（sendKey 偏好，默认 ⌘↩ 发送、↩ 换行）；
//   - 斜杠补全 = Claude Code 命令（内置常量表 + 用户 / 项目 skills 与 commands），选中后原样发进窗格；
//   - chip 行只读显示窗格当前模型（transcript 最近一条 assistant 的 model，读不到不显示）；
//   - 右侧「发往 ⚓ 工作区 · tab」；
//   - 窗格在跑（working）→ 主按钮位变停止（发 Esc 打断），有文字时旁边保留发送（排队）；
//   - 排队：服务端队列在窗格空闲后自动送达，列表可撤回 / 打断后立即发送；
//   - 附件 / 粘贴图片：走现有 /api/uploads，再物化成带原名的文件，把绝对路径插进消息；
//   - 窗格离线：外壳禁用 + 通知行里的「在 Herdr 里重新打开」。
//   - 弱网：发送失败（网络 / 网关）的消息进 Outbox（lib/outbox.ts），排在列表里「等待网络」，恢复后按序自动重发；
//     每条带 client_msg_id，服务端去重，不会重复打字；
//   - 发消息被拒是因为终端开着对话框（dialog_open，如信任目录）时，临时挂一张读屏卡（按 rev 防错作答）。

const MAX_UPLOADS = 6;
const NO_OUTBOX: OutboxItem[] = [];

function useClaudeCommands(workspace: string | null, enabled: boolean): ClaudeSlashCommand[] {
  const [commands, setCommands] = useState<ClaudeSlashCommand[]>(CLAUDE_BUILTIN_COMMANDS);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const params = new URLSearchParams();
    if (workspace) params.set("workspace", workspace);
    fetch(`/api/herdr/commands?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { commands?: ClaudeSlashCommand[] } | null) => {
        if (alive && d?.commands?.length) setCommands(d.commands);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspace, enabled]);
  return commands;
}

export function HerdrComposer({
  sessionId,
  pane,
  loading = false,
  mobileCompact = false,
  onMobileExpandedChange,
}: {
  sessionId: string;
  pane: HerdrPaneView | null;
  loading?: boolean;
  mobileCompact?: boolean;
  onMobileExpandedChange?: (expanded: boolean) => void;
}) {
  const { fleet } = useHerdrFleet();
  const { groups } = useHerdrConsole();
  const sendKey = useSessionStore((s) => s.sendKey);
  const reopen = useHerdrReopen(sessionId);
  const [text, setText] = useState("");
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // 拒发提示附带的电脑端单行草稿：有它时提示里给「清空并发送」，跟 notice 同生同灭。
  const [clearableDraft, setClearableDraft] = useState<string | null>(null);
  const [queue, setQueue] = useState<HerdrQueuedInput[]>([]);
  const [uploading, setUploading] = useState(0);
  // 发消息被 dialog_open 拒了：挂读屏卡（窗格可能报 idle，正常的 blocked 卡出不来）
  const [dialogProbe, setDialogProbe] = useState(false);
  const outboxItems = useSyncExternalStore(outbox().subscribe, outbox().snapshot, () => NO_OUTBOX);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deliveredTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const paneId = pane?.paneId ?? null;
  const online = Boolean(pane?.alive);
  const offline = !loading && !online;
  const working = online && pane?.status === "working";
  const model = pane?.agentKind === "claude" ? pane.pane.model ?? null : null;
  const workspace = pane?.pane.cwd ?? pane?.binding?.cwd ?? null;
  const target = useMemo(
    () => (paneId ? herdrSendTarget(groups, paneId) : null),
    [groups, paneId],
  );

  const commands = useClaudeCommands(workspace, online && pane?.agentKind === "claude");
  const matched = online && pane?.agentKind === "claude" ? matchClaudeCommands(text, commands) : [];
  const pickCommand = (command: ClaudeSlashCommand) => {
    setText(`/${command.name} `);
    ref.current?.focus();
  };
  const slashNav = useSlashNav(matched.length, text, (i) => pickCommand(matched[i]));

  useEffect(() => {
    onMobileExpandedChange?.(mobileCompact && mobileExpanded);
  }, [mobileCompact, mobileExpanded, onMobileExpandedChange]);

  // 排队列表的真源是服务端回执（fleet.inputDeliveries 带排队原文）：挂载 / 换窗格 /
  // 回执变化时，先把服务端还在排队的条目并进来（刷新、换标签页后恢复显示），再对账。
  const deliveries = fleet?.inputDeliveries;
  // 初值为空：首帧若已有回执也要走一次并入。
  const [seenDeliveries, setSeenDeliveries] = useState<typeof deliveries | null>(null);

  // 换窗格：排队列表、状态都属于旧窗格；清掉 seen 让下一帧按新窗格重新并入。
  const [queuePane, setQueuePane] = useState(paneId);
  const switched = queuePane !== paneId;
  if (switched) {
    setQueuePane(paneId);
    setQueue([]);
    setSeenDeliveries(null);
    setDelivered(false);
    setNotice(null);
    setClearableDraft(null);
    setDialogProbe(false);
  }

  // 本窗格在 Outbox 里的消息：等网络的显示在排队列表；调度器重发时被拒的（failed）放回输入框
  const paneOutbox = useMemo(
    () => (paneId ? outboxFor(outboxItems, "herdr", paneId) : NO_OUTBOX),
    [outboxItems, paneId],
  );
  const waitingOutbox = paneOutbox.filter((item) => !item.failed);
  const failedOutbox = paneOutbox.find((item) => item.failed);
  // 渲染期接手（同 fleet 回执对账的做法），只认一次；从 Outbox 删掉是外部副作用，放 effect
  const [takenOutbox, setTakenOutbox] = useState<string | null>(null);
  if (failedOutbox?.failed && takenOutbox !== failedOutbox.id) {
    const { failed } = failedOutbox;
    setTakenOutbox(failedOutbox.id);
    setText((current) => restoreDraft(current, failedOutbox.text));
    setNotice(`${failed.message}；已放回输入框`);
    setClearableDraft(failed.clearable ?? null);
    if (failed.code === "dialog_open") setDialogProbe(true);
  }
  useEffect(() => {
    if (takenOutbox) outbox().remove(takenOutbox);
  }, [takenOutbox]);

  // 排队列表 × fleet 回执对账：送达 / 撤回移除，失败把文字放回输入框。
  // 回执变了才对一次账（渲染期调整状态，不走 effect）；回执缺失不判过期 —— 刚入队时
  // fleet 可能还没刷新到它。
  if (!switched && seenDeliveries !== deliveries) {
    setSeenDeliveries(deliveries);
    const adopted = adoptServerQueue(queue, deliveries, paneId);
    const result = reconcileHerdrQueue(adopted, deliveries, 0, Number.POSITIVE_INFINITY);
    if (adopted !== queue || result.queue.length !== adopted.length) {
      setQueue(result.queue);
      if (result.failed.length > 0) {
        setText((current) => result.failed.reduce((acc, item) => restoreDraft(acc, item.text), current));
        // 发前读屏拒发的（对话框 / 电脑上有草稿）说清原因；其余失败照旧笼统提示。
        const refused = result.failed
          .map((item) => deliveries?.find((d) => d.inputId === item.inputId))
          .find((d) => d?.refusal);
        setNotice(refused?.error ? `${refused.error}；已放回输入框` : "排队的消息没能送达，已放回输入框");
        setClearableDraft(refused?.refusal?.clearable ?? null);
        if (refused?.refusal?.code === "dialog_open") setDialogProbe(true);
      }
    }
  }

  useEffect(
    () => () => {
      if (deliveredTimer.current) clearTimeout(deliveredTimer.current);
    },
    [],
  );

  /** clearDraft：用户在拒发提示里点了「清空并发送」，带回服务端给的那段单行草稿。 */
  const submit = async (clearDraft?: string) => {
    const outgoing = text.trim();
    if (!outgoing || !paneId || !online || sending || uploading > 0) return;
    setSending(true);
    setNotice(null);
    setClearableDraft(null);
    setDelivered(false);
    // 先落 Outbox 再发：请求失败在网络层时它还在盘上，刷新页面也会接着重发（同一个 client_msg_id）
    const clientMsgId = newClientMsgId();
    const box = outbox();
    box.add(
      newOutboxItem({ id: clientMsgId, kind: "herdr", target: paneId, text: outgoing, payload: clearDraft ? { clearDraft } : {} }),
      true,
    );
    try {
      const result = await sendHerdrInput(paneId, outgoing, clearDraft, clientMsgId);
      box.remove(clientMsgId);
      setDialogProbe(false);
      setText((current) => (current === text ? "" : current));
      if (result.status === "queued") {
        // 推送可能先于 POST 应答把这条并进列表了：按 inputId 去重。
        setQueue((prev) => prev.some((q) => q.inputId === result.inputId)
          ? prev
          : [...prev, { inputId: result.inputId, paneId, text: outgoing, queuedAt: result.queuedAt ?? Date.now() }]);
      } else {
        setDelivered(true);
        if (deliveredTimer.current) clearTimeout(deliveredTimer.current);
        deliveredTimer.current = setTimeout(() => setDelivered(false), 2_400);
      }
      if (mobileCompact) setMobileExpanded(false);
      void refreshHerdrFleet();
    } catch (error) {
      const failure = outboxFailure(error);
      if (failure.retry) {
        // 网络 / 网关失败：留在 Outbox 里等网络，输入框腾出来；列表里能看到、能撤回
        box.retry(clientMsgId, failure.message);
        box.release(clientMsgId);
        setText((current) => (current === text ? "" : current));
        if (mobileCompact) setMobileExpanded(false);
        return;
      }
      box.remove(clientMsgId);
      if (error instanceof HerdrActionError && error.refusal) {
        // 什么都没打，文字还在输入框里：直接说原因，单行草稿给一键清空重发。
        setNotice(error.message);
        setClearableDraft(error.refusal.clearable ?? null);
        if (error.refusal.code === "dialog_open") setDialogProbe(true);
      } else {
        setNotice(`发送失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!paneId || interrupting) return;
    setInterrupting(true);
    try {
      await sendHerdrKeys(paneId, ["Escape"]);
      void refreshHerdrFleet();
    } catch (error) {
      setNotice(`打断失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInterrupting(false);
    }
  };

  const withdraw = async (item: HerdrQueuedInput) => {
    try {
      await cancelHerdrInput(item.paneId, item.inputId);
      setQueue((prev) => prev.filter((q) => q.inputId !== item.inputId));
      setText((current) => restoreDraft(current, item.text));
      ref.current?.focus();
      void refreshHerdrFleet();
    } catch (error) {
      setNotice(`撤回失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ── 附件：上传 → 物化 → 路径插进光标处 ─────────────────────────────
  const insertPath = (path: string) => {
    const el = ref.current;
    const caret = el && document.activeElement === el ? el.selectionStart : null;
    setText((current) => insertPathAt(current, path, caret).text);
  };

  const startUpload = (file: File | Blob, filename: string | null) => {
    if (uploading >= MAX_UPLOADS) {
      setNotice(`最多同时上传 ${MAX_UPLOADS} 个附件`);
      return;
    }
    if (classifyFile(file.type, filename) === "unsupported") {
      setNotice(`不支持的文件类型：${filename ?? (file.type || "未知")}`);
      return;
    }
    setNotice(null);
    setUploading((n) => n + 1);
    void (async () => {
      try {
        const att = await uploadAttachment(file, filename);
        const response = await fetch("/api/herdr/attachments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash: att.hash, filename: att.filename ?? filename }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { path } = (await response.json()) as { path: string };
        insertPath(path);
      } catch (error) {
        setNotice(`附件上传失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    })();
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "file") continue;
      const file = it.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    // 剪贴板同时带文字（Word / 备忘录）就让浏览器照常贴文字；只有 Finder 附带的文件名时拦掉。
    const pasted = e.clipboardData.getData("text/plain");
    const names = new Set(files.map((f) => f.name).filter(Boolean));
    const onlyNames = pasted
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .every((l) => names.has(l) || names.has(l.split("/").pop() ?? ""));
    if (onlyNames) e.preventDefault();
    for (const file of files) startUpload(file, file.name || null);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) startUpload(files[i], files[i].name);
  };

  // ── 渲染 ─────────────────────────────────────────────────────────
  const compact = mobileCompact && !mobileExpanded;
  const canSend = online && !!text.trim() && !sending && uploading === 0;

  const sendButton = (
    <Tooltip
      content={uploading > 0 ? "等待附件上传…" : working ? "排队：窗格空闲后自动发送" : "发送到 Herdr 窗格"}
      shortcut={sendKey === "enter" ? "↩" : ["⌘", "↩"]}
      side="top"
    >
      <Button
        // bui send：空闲 = 30px 墨色圆钮；在跑时它退到停止左边当「排队发送」，降成次要外观。
        variant={working ? "secondary" : "ink"}
        size="icon"
        aria-label={working ? "排队发送到 Herdr" : "发送到 Herdr"}
        data-composer-primary={uploading > 0 || sending ? "loading" : "send"}
        data-herdr-send=""
        data-mobile-target="herdr-send"
        onClick={() => void submit()}
        disabled={!canSend}
        className="shrink-0 rounded-full! md:min-h-7.5 md:min-w-7.5"
      >
        {uploading > 0 || sending ? (
          <Spinner size="sm" label={null} className="text-current" />
        ) : (
          <Icon icon={ArrowUp} size="md" selected />
        )}
      </Button>
    </Tooltip>
  );
  const stopButton = (
    <Tooltip content="打断窗格（发送 Esc）" side="top">
      <Button
        variant="ink"
        size="icon"
        aria-label="打断窗格"
        data-composer-primary={interrupting ? "loading" : "stop"}
        data-herdr-stop=""
        onClick={() => void interrupt()}
        disabled={interrupting}
        className="shrink-0 rounded-full! md:min-h-7.5 md:min-w-7.5"
      >
        {interrupting ? (
          <Spinner size="sm" label={null} className="text-current" />
        ) : (
          <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden />
        )}
      </Button>
    </Tooltip>
  );
  // 在跑：停止占主按钮位；有文字时发送（排队）并排在它左边。
  const primary = working ? (
    <>
      {text.trim() && sendButton}
      {stopButton}
    </>
  ) : (
    sendButton
  );

  const attachButton = (
    <IconButton
      label="添加附件"
      title="添加图片 / 文件（路径会插进消息）"
      onClick={() => fileInputRef.current?.click()}
      disabled={!online}
      data-composer-attach=""
      className={COMPOSER_TOOL_ICON}
    >
      <Icon icon={Paperclip} />
    </IconButton>
  );

  const outboxQueueItems: ComposerQueueItem[] = waitingOutbox.map((item) => ({
    id: `outbox:${item.id}`,
    text: item.text,
    label: "等待网络",
    actions: [
      {
        label: "撤回",
        onClick: () => {
          outbox().remove(item.id);
          setText((current) => restoreDraft(current, item.text));
          ref.current?.focus();
        },
      },
    ],
  }));
  const queueItems: ComposerQueueItem[] = [...outboxQueueItems, ...queue.map((item, i) => ({
    id: item.inputId,
    text: item.text,
    actions: [
      ...(i === 0 && working
        ? [{ label: "打断后立即发送", onClick: () => void interrupt(), disabled: interrupting }]
        : []),
      { label: "撤回", onClick: () => void withdraw(item) },
    ],
  }))];

  const statusHint = offline
    ? ""
    : waitingOutbox.length > 0
      ? `${waitingOutbox.length} 条等待网络，恢复后自动按顺序发送`
    : working
      ? queue.length > 0
        ? `窗格工作中 · ${queue.length} 条排队，空闲后自动发送`
        : "窗格工作中：发送会排队，空闲后自动发送 · ■ 打断"
      : delivered
        ? "已送达 Herdr"
        : "";

  const offlineNotice = offline ? (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-herdr-readonly-composer="">
      <span>窗格已离线，会话只读</span>
      <Button
        variant="link"
        size="sm"
        data-herdr-composer-reopen=""
        onClick={() => void reopen.reopen()}
        disabled={reopen.state === "busy" || reopen.state === "done"}
      >
        {reopen.label}
      </Button>
    </span>
  ) : null;

  return (
    <ComposerShell
      textareaRef={ref}
      value={text}
      onValueChange={(value) => {
        setText(value);
        if (notice) setNotice(null);
        if (clearableDraft) setClearableDraft(null);
      }}
      onSubmit={() => void submit()}
      sendKey={sendKey}
      onSlashKeyDown={slashNav.handleKeyDown}
      suggestions={
        matched.length > 0 && (
          <SkillPickerList
            skills={[]}
            onPick={() => {}}
            slashItems={matched.map((c) => ({
              name: `/${c.name}`,
              description: c.description,
              kindLabel: CLAUDE_SLASH_KIND_LABEL[c.kind],
              kind: c.kind === "skill" ? "skill" : "command",
            }))}
            onPickSlashItem={(i) => pickCommand(matched[i])}
            activeIndex={slashNav.active}
          />
        )
      }
      disabled={!online}
      placeholder={
        loading && !pane ? "正在读取窗格…" : offline ? "窗格已离线" : "发给 Herdr 窗格…  输入 / 调出 Claude 命令"
      }
      compactPlaceholder={offline ? "窗格已离线" : "发给 Herdr…"}
      mobileCompact={mobileCompact}
      mobileExpanded={mobileExpanded}
      onMobileExpandedChange={setMobileExpanded}
      keepExpanded={Boolean(text.trim() || uploading > 0 || notice)}
      onPaste={handlePaste}
      onDropFiles={handleDrop}
      chips={
        model ? (
          <Tooltip content="窗格当前模型（只读；在窗格里用 /model 切换）" side="top">
            <span
              tabIndex={0}
              data-herdr-model=""
              className="inline-flex h-6.5 min-w-0 max-w-56 items-center gap-1.5 rounded-chip bg-surface-muted px-2 text-[11.5px] text-ink-muted shadow-hairline"
            >
              <Icon icon={Cpu} size="sm" />
              <span className="min-w-0 truncate font-mono">{model}</span>
            </span>
          </Tooltip>
        ) : null
      }
      tools={attachButton}
      compactTools={attachButton}
      sendTo={
        target && (
          <Tooltip content="消息会直接打进这个 Herdr 窗格" side="top">
            <span
              tabIndex={0}
              data-composer-send-to=""
              data-herdr-send-to=""
              className="hidden sm:inline-flex min-w-0 max-w-64 items-center gap-1 mr-1.5 px-1 text-[12.5px] text-ink-faint"
            >
              <span className="shrink-0">发往</span>
              <Icon icon={Anchor} size="sm" />
              <b className="min-w-0 truncate font-medium text-ink-muted">{target.workspace}</b>
              <span className="shrink-0">·</span>
              <span className="shrink-0 font-mono">{target.tab}</span>
            </span>
          </Tooltip>
        )
      }
      primary={primary}
      state={working ? "stopping" : compact ? "compact" : "expanded"}
      notice={offlineNotice ?? (notice && clearableDraft ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-herdr-send-refused="">
          <span>{notice}</span>
          <Button
            variant="link"
            size="sm"
            data-herdr-clear-draft=""
            onClick={() => void submit(clearableDraft)}
            disabled={sending}
          >
            清空电脑上的草稿并发送
          </Button>
        </span>
      ) : notice)}
      hintLeft={
        <span data-herdr-delivery={delivered ? "delivered" : queue.length ? "queued" : "idle"} aria-live="polite">
          {statusHint}
        </span>
      }
      hintRight={herdrComposerHint(sendKey)}
      queue={queueItems}
      rootProps={{ "data-herdr-composer": "" }}
      textareaProps={{
        "data-herdr-input": "",
        "data-mobile-target": "herdr-input",
        "aria-label": "发给 Herdr 的消息",
      }}
      beforeCard={
        <>
        {dialogProbe && pane && pane.status !== "blocked" && (
          <div className="mb-2" data-herdr-dialog-probe="">
            <HerdrInteractionCard pane={pane} probeScreen compact />
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptFor("all")}
          multiple
          onChange={(e) => {
            const files = e.target.files;
            if (files) for (let i = 0; i < files.length; i++) startUpload(files[i], files[i].name);
            e.target.value = "";
          }}
          className="hidden"
        />
        </>
      }
    />
  );
}
