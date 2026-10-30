"use client";
import { useRef } from "react";
import { Bot, CalendarClock, ConciergeBell, Cpu, Stethoscope, type LucideIcon } from "lucide-react";
import { QuestionInput, type QuestionInputHandle } from "@/components/QuestionInput";
import { Icon, cn } from "@/components/ui";

// 管家草稿首页：还没有管家会话时 /butler 落到这里。发出第一句 = streamRoot
// 带着管家 agentId 建会话（见 sessionStore 的 butlerDraft），之后就是普通会话。
const STARTERS: { icon: LucideIcon; title: string; hint: string; prompt: string }[] = [
  {
    icon: CalendarClock,
    title: "每天早上跑一次仓库日报",
    hint: "建任务 + 挂 cron 触发器",
    prompt: "每个工作日早上 9 点，在 ~/code 下跑一次仓库日报：按模块归类昨天的提交，标出没测试覆盖的改动。",
  },
  {
    icon: Bot,
    title: "建一个专门审 PR 的 Agent",
    hint: "人设、模型、工具白名单",
    prompt: "建一个专门审 PR 的 Agent：只读工具，挑正确性问题，不提风格意见。",
  },
  {
    icon: Cpu,
    title: "看看模型和凭证",
    hint: "默认模型、provider、CLI 登录态",
    prompt: "现在默认模型是什么？各 provider 的 key 和 CLI 登录态有没有问题？",
  },
  {
    icon: Stethoscope,
    title: "体检一下配置",
    hint: "失败任务、停用项、过期凭证",
    prompt: "体检一下 Trellis 的配置：有没有失败的任务、出错的机器人、快过期的凭证？",
  },
];

export function ButlerHome({ isMobile }: { isMobile: boolean }) {
  const inputRef = useRef<QuestionInputHandle>(null);
  return (
    <main
      data-butler-home
      className="fixed inset-x-0 bottom-0 overflow-y-auto overscroll-contain"
      style={
        isMobile
          ? { top: "var(--trellis-header-h)", paddingBottom: "var(--safe-bottom)" }
          : { top: "calc(3rem + 2.25rem)", left: "var(--trellis-sb, 0px)" }
      }
    >
      <div className={cn("mx-auto w-full max-w-[720px] px-6 pb-16 max-md:px-4", isMobile ? "pt-5" : "pt-16")}>
        <section className="flex flex-col items-center text-center">
          <div className="ui-enter-up mb-4 grid size-11 place-items-center rounded-card bg-accent-muted text-accent-ink shadow-hairline">
            <Icon icon={ConciergeBell} size="lg" />
          </div>
          <h1
            className="ui-enter-up text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink-strong max-md:text-title"
            style={{ animationDelay: "40ms" }}
          >跟管家说你想怎么配 Trellis</h1>
          <p className="ui-enter-up mt-1.5 mb-6 max-w-md text-body text-ink-muted max-md:text-ui" style={{ animationDelay: "80ms" }}>
            Agent、定时任务都能用一句话建和改；模型、机器人、版本这些先能查。动手之前管家会先把要改什么讲给你听。
          </p>
          <div className="ui-enter-up w-full" style={{ animationDelay: "120ms" }}>
            <QuestionInput isMobile={isMobile} variant="home" butler autoFocus={!isMobile} controlRef={inputRef} />
          </div>
        </section>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {STARTERS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              data-butler-starter
              onClick={() => inputRef.current?.fill(s.prompt)}
              className="ui-enter-up group rounded-card bg-surface-raised px-3.5 py-3 text-left shadow-raise transition-colors duration-100 hover:bg-surface-hover"
              style={{ animationDelay: `${160 + i * 50}ms` }}
            >
              <span className="flex items-center gap-2 text-ui font-medium text-ink">
                <Icon icon={s.icon} size="sm" className="text-ink-faint transition-colors group-hover:text-ink" />
                {s.title}
              </span>
              <span className="mt-1 block text-label text-ink-faint">{s.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
