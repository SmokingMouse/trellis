import { NextRequest, NextResponse } from "next/server";
import { abortRun, getActiveRuns } from "@/lib/server/run-bus";
import { stopTtyd } from "@/lib/server/ttyd";

// 优雅停机的排空钩子，**只给网关（server.ts）在收到 SIGTERM 时调**。
//
// 为什么是一条 HTTP 路由而不是 Next 进程里的 `process.on("SIGTERM")`：
// 两个都靠不住。① 信号只送给 launchd job 的主进程（网关），Next 是它的子进程，
// 转发得由网关自己做；② 就算转发了，`instrumentation.ts` 里注册的 handler 未必
// 和 route handler 处在同一个模块实例里 —— run-bus 的 RUNS 是模块级 Map，
// 拿错实例就是对着一个空 Map 排空，静默无效。路由处理器与 run-bus 天然同注册表，
// 不用赌。
//
// 不排空的代价（实测既有行为）：spawn 出去的 claude/codex 子进程既不会被 kill、
// 也不会随父进程死，重启后 reparent 到 launchd 继续跑、继续往 jsonl 里写、继续
// 烧 token，而 DB 里那行永远卡在 status='streaming'，要等下一次 migrate() 的
// reap 才被判死。
//
// 认证：网关 spawn Next 时下发一次性的 TRELLIS_SHUTDOWN_TOKEN，只有它知道。
// 未配置该 env = 功能关闭（404，不暴露这条路径存在）。这条路由同样盖在
// proxy.ts 的 cookie 闸下面，网关调用时会带上自己那份 TRELLIS_AUTH_TOKEN。
export async function POST(req: NextRequest) {
  const expected = process.env.TRELLIS_SHUTDOWN_TOKEN;
  if (!expected) return new NextResponse("Not found", { status: 404 });
  if (req.headers.get("x-trellis-shutdown") !== expected) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const active = getActiveRuns();
  for (const r of active) abortRun(r.nodeId);

  // 等子进程真的被收走。abortRun 只是 flip 了 AbortSignal，SDK 那边 teardown
  // 要跑几个 tick；这里不等的话网关转头就 kill，等于没排空。
  const deadline = Date.now() + 8000;
  while (getActiveRuns().length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  stopTtyd();

  return NextResponse.json({
    aborted: active.length,
    remaining: getActiveRuns().length,
  });
}
