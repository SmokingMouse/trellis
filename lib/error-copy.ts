// 把原始错误翻成「发生了什么 + 可以怎么办」两句人话（ErrorCallout 用）。
// 原来 ~62 处直接把 e.message 摆给用户（"Failed to fetch"、"HTTP 500"…）。
// 这里只做常见几类的归类；认不出的给通用文案，原始信息仍在详情里可展开。

export type ErrorCopy = {
  /** 发生了什么（一句，不带技术词） */
  what: string;
  /** 可以怎么办（一句，可执行） */
  hint: string;
  /** 原始错误文本，折叠在详情里 */
  raw: string;
};

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function statusOf(raw: string): number | null {
  const m = raw.match(/\b(?:HTTP\s*|status\s*:?\s*)?([45]\d\d)\b/i);
  return m ? Number(m[1]) : null;
}

export function describeError(error: unknown): ErrorCopy {
  const raw = errorText(error);
  const name = error instanceof Error ? error.name : "";
  const low = raw.toLowerCase();

  if (name === "AbortError" || /timed? ?out|timeout|超时/.test(low)) {
    return { what: "请求超时了", hint: "网络或服务端响应慢，稍后再试一次。", raw };
  }
  if (/failed to fetch|networkerror|network request failed|load failed|econnrefused|fetch failed/.test(low)) {
    return { what: "连不上 Trellis 服务", hint: "检查网络或服务是否在运行，然后重试。", raw };
  }
  const status = statusOf(raw);
  if (status === 401) return { what: "登录已失效", hint: "刷新页面重新登录后再试。", raw };
  if (status === 403) return { what: "没有权限执行这个操作", hint: "确认当前账号的权限，或换有权限的账号。", raw };
  if (status === 404) return { what: "要找的内容不存在", hint: "它可能已被删除或移动，刷新列表看看。", raw };
  if (status === 409) return { what: "内容已被别处改动", hint: "刷新后基于最新内容再操作。", raw };
  if (status === 413) return { what: "内容太大，服务端拒收", hint: "缩小文件或拆成几次提交。", raw };
  if (status === 429) return { what: "请求太频繁，被限流了", hint: "等一会儿再试。", raw };
  if (status !== null && status >= 500) {
    return { what: "服务端出错了", hint: "稍后重试；反复出现请把下方详情发给维护者。", raw };
  }
  return { what: "操作没有完成", hint: "重试一次；反复出现请把下方详情发给维护者。", raw };
}
