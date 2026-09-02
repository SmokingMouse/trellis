export type TaskLarkOutcomeStatus = "done" | "error" | "timeout";
export type TaskLarkNotifyOn = "never" | "error" | "always";

/** notify 标题与飞书失败消息共用这一份状态文案，避免超时在两个出口变成两种说法。 */
export function taskRunStatusText(status: TaskLarkOutcomeStatus): "完成" | "失败" | "超时" {
  return status === "done" ? "完成" : status === "timeout" ? "超时" : "失败";
}

/** null = 本次不应推送；成功空回答与失败 notify_on 门控都收口在这里。 */
export function taskLarkPushContent(args: {
  taskName: string;
  status: TaskLarkOutcomeStatus;
  notifyOn: TaskLarkNotifyOn;
  response: string;
  errorMessage: string | null | undefined;
}): string | null {
  if (args.status === "done") return args.response.trim() ? args.response : null;
  if (args.notifyOn === "never") return null;
  const title = `任务「${args.taskName}」${taskRunStatusText(args.status)}`;
  if (args.status === "timeout") return title;
  return `${title}：${(args.errorMessage || "未知错误").slice(0, 200)}`;
}
