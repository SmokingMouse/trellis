"use client";
import { QuestionInput } from "@/components/QuestionInput";
import { RoleAvatar } from "@/components/ui/Avatar";
import { cn } from "@/components/ui";
import type { Role } from "@/lib/roles";

// 角色草稿：角色还没有固定会话时点进来落到这里（sessionStore.roleDraft）。
// 看上去就是一条空的角色对话——头像、名字、介绍，下面是输入框；发出第一句 =
// streamRoot 带着角色的 agentId / 目录建会话，服务端回写 home_session_id，之后都进那条会话。
export function RoleHome({ role, isMobile }: { role: Role; isMobile: boolean }) {
  return (
    <main
      data-role-home={role.id}
      className="fixed inset-x-0 bottom-0 overflow-y-auto overscroll-contain"
      style={
        isMobile
          ? { top: "var(--trellis-header-h)", paddingBottom: "var(--safe-bottom)" }
          : { top: "calc(3rem + 2.25rem)", left: "var(--trellis-sb, 0px)" }
      }
    >
      <div className={cn("mx-auto w-full max-w-[720px] px-6 pb-16 max-md:px-4", isMobile ? "pt-8" : "pt-20")}>
        <section className="flex flex-col items-center text-center">
          <RoleAvatar role={role} size="xl" className="ui-enter-up mb-4" />
          <h1
            className="ui-enter-up text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink-strong max-md:text-title"
            style={{ animationDelay: "40ms" }}
          >
            {role.name}
          </h1>
          {role.intro && (
            <p
              className="ui-enter-up mt-1.5 max-w-md text-body text-ink-muted max-md:text-ui"
              style={{ animationDelay: "80ms" }}
            >
              {role.intro}
            </p>
          )}
          <p className="ui-enter-up mt-1 mb-6 text-label text-ink-faint" style={{ animationDelay: "100ms" }}>
            {role.memoryEnabled ? "它会记住聊过的要紧事，下次还在" : "记忆已关：每次对话从头开始"}
          </p>
          <div className="ui-enter-up w-full text-left" style={{ animationDelay: "120ms" }}>
            <QuestionInput isMobile={isMobile} variant="home" role={role} autoFocus={!isMobile} />
          </div>
        </section>
      </div>
    </main>
  );
}
