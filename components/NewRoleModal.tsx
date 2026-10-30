"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Box, Plus, Sparkles, X, type LucideIcon } from "lucide-react";
import {
  Button,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Modal,
  Switch,
  Textarea,
  cn,
} from "@/components/ui";
import { RoleField, RoleHuePicker, RoleModelSelect } from "@/components/RoleFields";
import { BUILTIN_AGENT_SEEDS } from "@/lib/agent-presets";
import { isRoleNameTaken } from "@/lib/role-manage";
import { ROLE_AVATAR_HUES } from "@/lib/roles";
import { useRoleStore } from "@/stores/roleStore";

// 新建角色弹窗（原型 docs/ui-redesign/mockups/09-roles.html 的 [data-new-modal]）。
// 开关在 roleStore.newRoleOpen：侧栏 ＋、设置页「新建角色」、手机首页共用这一个实例，
// 由 NewRoleHost 在根布局挂一次——不在各入口各挂一份，免得两处同时打开叠两层。

type Source = "blank" | "template";

const SOURCES: { id: Source | "chat"; icon: LucideIcon; title: string; desc: string }[] = [
  { id: "blank", icon: Plus, title: "空白", desc: "自己写名字和性格" },
  { id: "template", icon: Box, title: "从模板", desc: "费曼考官、犀利评论者…" },
  // P1 不做（docs/roles-p1.md 范围表），占位让人知道有这条路
  { id: "chat", icon: Sparkles, title: "从会话提炼", desc: "即将推出" },
];

/** 根布局挂一次；关着的时候什么都不渲染（Modal 是条件渲染的）。 */
export function NewRoleHost() {
  const open = useRoleStore((s) => s.newRoleOpen);
  const setOpen = useRoleStore((s) => s.setNewRoleOpen);
  return open ? <NewRoleModal onClose={() => setOpen(false)} /> : null;
}

export function NewRoleModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { roles, loaded, refresh, create } = useRoleStore();
  const [source, setSource] = useState<Source>("blank");
  const [template, setTemplate] = useState<string | null>(null);
  const [hue, setHue] = useState<number>(ROLE_AVATAR_HUES[0]);
  const [name, setName] = useState("");
  const [intro, setIntro] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // 正文可能滚在顶部，出错时把错误卡滚进视野
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  // 重名校验要拿到已有角色；从侧栏打开时列表多半已加载，从别处进来补拉一次
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const nameTaken = isRoleNameTaken(name, roles);
  const canCreate = !!name.trim() && !nameTaken && !busy;

  const pickTemplate = (slug: string) => {
    const seed = BUILTIN_AGENT_SEEDS.find((s) => s.slug === slug);
    if (!seed) return;
    setTemplate(slug);
    // 模板就是一份预填：直接覆盖三栏，用户在下面接着改
    setName(seed.name);
    setIntro(seed.description);
    setSystemPrompt(seed.systemPrompt);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    const r = await create({
      name: name.trim(),
      intro: intro.trim(),
      systemPrompt,
      avatarHue: hue,
      // 头像字跟着名字走（roleGlyph 的空串回落），以后改名不用再改头像
      avatarGlyph: "",
      model,
      workDir: workDir.trim() || null,
      memoryEnabled,
    });
    setBusy(false);
    if (typeof r === "string") {
      setError(r);
      return;
    }
    onClose();
    // ?role=<id> 由对话面（WP2）接管：打开角色会话或进草稿态
    router.push(`/?role=${encodeURIComponent(r.id)}`);
  };

  return (
    <Modal onClose={onClose} size="lg" title="新建角色">
      {/* 桌面卡片高度封顶、正文滚、底栏不动；手机 sheet 同一结构（sheet 外层自己也能滚） */}
      <form onSubmit={submit} className="flex max-h-[min(88dvh,820px)] flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3.5">
          <h2 className="min-w-0 flex-1 text-body font-semibold tracking-tight text-ink-strong">
            新建角色
          </h2>
          <IconButton label="关闭" size="sm" onClick={onClose}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4">
          <div role="radiogroup" aria-label="从哪里开始" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {SOURCES.map((s) => {
              const disabled = s.id === "chat";
              const on = s.id === source;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={disabled}
                  onClick={() => !disabled && setSource(s.id as Source)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-card p-3 text-left transition-[background-color,box-shadow] duration-100",
                    on
                      ? "bg-accent-muted ring-1 ring-inset ring-accent-line"
                      : "bg-surface-canvas shadow-hairline hover:bg-surface-hover",
                    disabled && "cursor-not-allowed opacity-55 hover:bg-surface-canvas",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-7 place-items-center rounded-field",
                      on ? "bg-surface-raised text-accent-ink shadow-btn" : "bg-surface-raised text-ink-muted shadow-hairline",
                    )}
                  >
                    <Icon icon={s.icon} size="sm" />
                  </span>
                  <span className="text-ui font-medium text-ink">{s.title}</span>
                  <span className="text-label text-ink-muted">{s.desc}</span>
                </button>
              );
            })}
          </div>

          {source === "template" && (
            <div className="flex flex-col gap-1.5">
              <span id="new-role-tpl" className="text-ui font-medium text-ink">
                选一个模板
              </span>
              <div
                role="radiogroup"
                aria-labelledby="new-role-tpl"
                className="flex flex-col divide-y divide-line overflow-hidden rounded-card bg-surface-canvas shadow-hairline"
              >
                {BUILTIN_AGENT_SEEDS.map((seed) => {
                  const on = template === seed.slug;
                  return (
                    <button
                      key={seed.slug}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => pickTemplate(seed.slug)}
                      className={cn(
                        "flex min-h-11 items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100",
                        on ? "bg-surface-hover" : "hover:bg-surface-hover",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui font-medium text-ink">{seed.name}</span>
                        <span className="block truncate text-label text-ink-muted">{seed.description}</span>
                      </span>
                      {on && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1 md:grid md:grid-cols-[96px_minmax(0,1fr)] md:items-center md:gap-x-4">
            <span className="text-ui font-medium text-ink md:text-ink-muted">头像</span>
            <RoleHuePicker hue={hue} name={name} glyph="" onChange={setHue} />
            <span className="text-label text-ink-muted md:col-start-2">头像上的字取名字的第一个字</span>
          </div>

          <RoleField
            inline
            label="名字"
            hint="名字不能和已有角色重复"
            error={nameTaken ? "已经有叫这个名字的角色了" : null}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={name}
                onChange={(e) => setName(e.target.value)}
                invalid={nameTaken}
                required
                maxLength={40}
                placeholder="例如：老周"
                autoComplete="off"
              />
            )}
          </RoleField>

          <RoleField inline label="一句话介绍">
            {({ id }) => (
              <Input
                id={id}
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
                placeholder="代码审稿人。冷静、讲证据，只报能复现的问题。"
              />
            )}
          </RoleField>

          <RoleField inline label="性格与说话方式">
            {({ id }) => (
              <Textarea
                id={id}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={5}
                className="resize-y"
                placeholder="说话直接，不客套。宁可少给几条可复现的问题，也不堆推测性的意见。"
              />
            )}
          </RoleField>

          <div className="flex flex-col gap-4">
            <RoleField inline label="默认目录" hint="不填就用角色自己的目录">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={workDir}
                  onChange={(e) => setWorkDir(e.target.value)}
                  className="font-mono"
                  placeholder="~/code/project"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </RoleField>
            <RoleField inline label="模型">
              {({ id }) => <RoleModelSelect id={id} value={model} onChange={setModel} />}
            </RoleField>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 self-start md:ml-[112px]">
            <Switch checked={memoryEnabled} onCheckedChange={setMemoryEnabled} />
            <span className="text-ui text-ink">
              使用记忆
              <span className="ml-1.5 text-label text-ink-muted">它会记下关于你的事，下次接着用</span>
            </span>
          </label>

          {/* 放在正文末尾、紧挨底栏：点「创建」时视线在这里 */}
          {error && (
            <div ref={errorRef}>
              <ErrorCallout compact error={error} title="没能创建角色" />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
          <span className="mr-auto hidden text-label text-ink-muted md:inline">
            创建后发一句话就能开始聊
          </span>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!canCreate}>
            创建
          </Button>
        </div>
      </form>
    </Modal>
  );
}
