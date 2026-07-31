import "server-only";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// S88: 通知出口。刻意做成「接口 + 注册表」而不是直接调某个推送服务 ——
// 未来「任务跑完把结果发回飞书群」= 再注册一个 channel，任务层零改动。
// 而「飞书消息进来当触发器」是 task_triggers.kind='lark'，与本层完全正交。

export type NotifyEvent = {
  kind: "task_run_done" | "task_run_error" | "task_run_timeout";
  title: string;
  body: string;
  /** 站内深链，形如 /?session=<sid>&node=<nid> */
  link?: string;
  taskId: string;
  runId: string;
};

export interface NotifyChannel {
  id: string;
  send(e: NotifyEvent): Promise<void>;
}

const CHANNELS = new Map<string, NotifyChannel>();

export function registerChannel(c: NotifyChannel): void {
  CHANNELS.set(c.id, c);
}

/** 扇出到所有渠道。逐个 try/catch —— **通知发不出去绝不能影响任务本身的留档**。
 *
 * 内置的 commandChannel **不走注册表**，每次直接调：Next 里 instrumentation.ts
 * 与 route handler 可能被打进不同的 bundle，模块级 Map 因此不保证共享 ——
 * 「在 instrumentation 里注册、在 route 里扇出」实测收不到（2026-07-31）。
 * 注册表留给运行期动态添加的渠道（将来的飞书群等）。 */
export async function notify(e: NotifyEvent): Promise<void> {
  const all = [commandChannel, ...CHANNELS.values()];
  for (const c of all) {
    try {
      await c.send(e);
    } catch (err) {
      console.error(`[notify] 渠道 ${c.id} 发送失败：`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// 命令模板渠道
// ---------------------------------------------------------------------------
//
// ~/.trellis/notify.json:
//   { "command": ["/Users/x/bin/push", "{title}", "{body}", "{link}"] }
//
// 刻意不硬绑任何一家推送服务：本机已经有 phone-push、飞书 CLI 等一堆现成出口，
// 与其在 trellis 里再实现一遍认证和重试，不如让用户把已经能用的命令填进来。
// 配置存文件不存 DB，照 lib/deploy-state.ts 的既有范例（运行期配置的家是
// ~/.trellis/，不是 schema）。

const CONFIG_PATH = path.join(os.homedir(), ".trellis", "notify.json");

type NotifyConfig = { command?: string[] };

function readConfig(): NotifyConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as NotifyConfig;
  } catch {
    return null; // 没配就是不用，不是错误
  }
}

export const commandChannel: NotifyChannel = {
  id: "command",
  async send(e) {
    const cfg = readConfig();
    if (!cfg?.command?.length) return;
    // 占位符替换后**作为 argv 传入**，不拼 shell 字符串 —— body 里带引号 /
    // 反引号 / $() 的时候，拼串就是一个命令注入。
    const argv = cfg.command.map((part) =>
      part
        .replaceAll("{title}", e.title)
        .replaceAll("{body}", e.body)
        .replaceAll("{link}", e.link ?? "")
        .replaceAll("{kind}", e.kind)
        .replaceAll("{taskId}", e.taskId)
        .replaceAll("{runId}", e.runId),
    );
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
    // 别让一个卡死的推送命令拖住任务收尾 —— 10s 够任何 HTTP 推送跑完。
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
  },
};

/** 保留给将来在运行期装配渠道用（飞书群等）。内置的 commandChannel 不经由它 ——
 * 见 notify() 的注释：跨 bundle 的模块级注册表不可靠。 */
export function installDefaultChannels(): void {
  /* no-op：commandChannel 已在 notify() 里直连 */
}
