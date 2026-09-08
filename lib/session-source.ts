import type { Session } from "./types";

/** 自动化与外部入口沿用侧栏 chip；原生 user 会话不增加标记。 */
export function sessionSourceChip(session: Pick<Session, "kind" | "origin">) {
  if (session.kind === "herdr" || session.origin === "herdr") {
    return { label: "⚓", title: "Herdr 会话" };
  }
  if (session.kind === "task") return { label: "⏱", title: "定时任务会话" };
  if (session.kind === "lark" || session.origin === "lark") {
    return { label: "💬", title: "飞书会话" };
  }
  return null;
}
