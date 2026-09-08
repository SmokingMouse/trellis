export interface AsEngineEvent { method: string; payload: unknown; at: number | null }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function brief(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}
/** Native frames wrap their useful fields in params; Claude system frames do not. */
function fields(payload: unknown) {
  const root = record(payload);
  return { ...root, ...record(root.params) };
}
export function isDebugEngineEvent(method: string, payload: unknown): boolean {
  const p = fields(payload);
  if (/error|warn|permission|readonly_(denied|tools_disabled)/i.test(method) || p.error || p.level === "error" || p.level === "warning") return false;
  return !(/^(?:(?:thread\/)?engine[/.])?(started|exited|exit|restart|restarted|systemError)$/i.test(method) || method === "thread/permission/changed");
}
export function summarizeEngineEvent(method: string, payload: unknown): string {
  const p = fields(payload), item = record(p.item), detail = { ...item, ...record(item.payload) };
  const command = brief(detail.command ?? p.command ?? record(detail.input).command);
  if (command) return command;
  if (/hook[\/_]/i.test(method)) {
    const hook = record(p.hook);
    const name = brief(p.hookName ?? p.hook_name ?? p.hookEvent ?? p.eventName ?? hook.name) || "未命名";
    const duration = p.durationMs ?? p.duration_ms ?? hook.durationMs;
    return `hook ${name} ${/completed|response|end/.test(method) ? "完成" : "开始"}${typeof duration === "number" ? ` · ${duration} ms` : ""}`;
  }
  if (/(?:^|[/.])exit(?:ed)?$/i.test(method)) {
    const code = p.exitCode ?? p.code ?? p.exit_code;
    return `引擎退出${typeof code === "number" ? ` (${code})` : ""}`;
  }
  if (/(?:^|[/.])(?:restart|restarted)$/i.test(method)) return "引擎重启";
  if (/(?:^|[/.])started$/i.test(method) && !method.startsWith("item/")) return "引擎已启动";
  const message = brief(p.message ?? record(p.error).message ?? p.error ?? p.reason);
  if (/error/i.test(method)) return message ? `错误：${message}` : "引擎发生错误";
  if (/warn/i.test(method)) return message ? `警告：${message}` : "引擎警告";
  if (/permission|readonly/i.test(method)) return `权限：${brief(p.permission ?? p.mode ?? p.behavior) || message || "已更新"}`;
  if (method.startsWith("item/")) {
    const names: Record<string, string> = { agentMessage: "回复", reasoning: "推理", commandExecution: "命令", fileChange: "文件修改", toolCall: "工具调用", mcpToolCall: "MCP 工具调用" };
    return `${names[String(detail.type)] || brief(detail.type) || "事件"}${method.endsWith("completed") ? "完成" : "更新"}`;
  }
  return message || brief(payload) || "收到事件，展开查看详情";
}
export function relativeEngineEventTime(at: number | null, now: number): string {
  if (at === null) return "时间未知";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : seconds < 86400 ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 86400)} 天前`;
}
/** Preserve old sessionStorage strings without inventing historical timestamps. */
export function restoreEngineEvents(value: unknown): AsEngineEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap(entry => {
    if (typeof entry === "string") {
      const split = entry.indexOf(": ");
      let payload: unknown = split < 0 ? entry : entry.slice(split + 2);
      try { payload = JSON.parse(String(payload)); } catch {}
      return [{ method: split < 0 ? "unknown" : entry.slice(0, split), payload, at: null }];
    }
    const p = record(entry);
    return typeof p.method === "string" ? [{ method: p.method, payload: p.payload, at: typeof p.at === "number" && Number.isFinite(p.at) ? p.at : null }] : [];
  });
}
