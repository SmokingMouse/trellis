import type { Session } from "./types";

/** 所有会话导航查询共用的来源范围；列名只允许查询内部的固定标识符。 */
export const sidebarSessionKinds = ["user", "lark", "herdr", "task"] as const;
export function sessionSourcePredicate(column: "kind" | "s.kind" = "kind"): string {
  return `${column} IN (${sidebarSessionKinds.map(kind => `'${kind}'`).join(", ")})`;
}

/** 可被全局搜索 / `@` 引用的会话来源：侧栏可见的那几种 + 角色固定会话（role）+ 群聊（group）。
 * 角色 / 群聊不在会话列表里（有自己的侧栏分区），但内容同样值得被搜到、被引用。 */
export const referableSessionKinds = [...sidebarSessionKinds, "role", "group"] as const;
export function referableSessionPredicate(column: "kind" | "s.kind" = "kind"): string {
  return `${column} IN (${referableSessionKinds.map(kind => `'${kind}'`).join(", ")})`;
}

/** 自动化与外部入口沿用侧栏 chip；原生 user 会话不增加标记。 */
export function sessionSourceChip(session: Pick<Session, "kind" | "origin" | "backend">) {
  if (session.origin === "external") {
    return { label: "外部", title: session.backend ? `外部会话 · ${session.backend}` : "外部会话" };
  }
  if (session.kind === "herdr" || session.origin === "herdr") {
    return { label: "Herdr", title: "Herdr 会话" };
  }
  if (session.kind === "task") return { label: "定时", title: "定时任务会话" };
  if (session.kind === "lark" || session.origin === "lark") {
    return { label: "飞书", title: "飞书会话" };
  }
  return null;
}
