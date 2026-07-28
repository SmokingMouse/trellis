import "server-only";
import { startRollback, startUpdate, updateStatus } from "@/lib/server/update";
import { tailLog } from "@/lib/deploy-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/update?fetch=1  → 当前版本 / 可更新版本 / 落后的 commit / 部署状态
// POST /api/update  {action:"update"|"rollback", force?}
//
// **这是一个远程代码执行入口**：一次 POST 会在宿主机上 checkout 一个 commit、
// 装依赖、构建、然后把整个服务切过去。它靠三道闸站得住：
//   1. proxy.ts 的 cookie 闸盖住整个 /api（这台机器挂着公网隧道，这条是底线）；
//   2. 只能部署**仓库里已经存在的 ref**，请求体不接受任意命令、任意 URL；
//   3. 有会话正在生成时默认拒绝，要越过得显式带 force（界面上是单独一个勾）。
//
// 决策背景：progress/decisions.md「无人值守自动更新 —— 拒绝，切换必须是显式
// 动作」。点按钮就是那个显式动作，扳机只是从 `make deploy` 挪到了界面上。

export async function GET(req: Request) {
  const doFetch = new URL(req.url).searchParams.get("fetch") === "1";
  const s = updateStatus(doFetch);
  return Response.json({
    ...s,
    // 日志尾巴只在部署真的失败时才给 —— 它含绝对路径和 stderr。闸已经在
    // proxy.ts 拦过一道，这里只是不做无谓的暴露。
    logTail:
      s.deploy && (s.deploy.phase === "failed" || s.deploy.phase === "broken")
        ? tailLog(s.deploy.logFile, 40)
        : null,
  });
}

export async function POST(req: Request) {
  let body: { action?: string; ref?: string; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  if (body.action === "rollback") {
    const r = startRollback();
    return r.ok
      ? Response.json({ ok: true, logFile: r.logFile })
      : Response.json({ error: r.reason }, { status: 409 });
  }

  if (body.action !== "update") {
    return Response.json({ error: "action 只能是 update 或 rollback" }, { status: 400 });
  }

  // ref 只允许最保守的一组字符，且最终仍由 deploy.ts 的 `git rev-parse --verify`
  // 判真伪 —— 这里挡的是「别把奇怪东西塞进 argv」，不是权限。
  const ref = (body.ref ?? "origin/main").trim();
  if (!/^[\w./-]{1,120}$/.test(ref)) {
    return Response.json({ error: "ref 含非法字符" }, { status: 400 });
  }

  const s = updateStatus(false);
  if (s.activeRuns > 0 && !body.force) {
    return Response.json(
      { error: `有 ${s.activeRuns} 个会话正在生成，切换会把它们全部中断`, needsForce: true },
      { status: 409 },
    );
  }

  const r = startUpdate({ ref, force: body.force });
  return r.ok
    ? Response.json({ ok: true, logFile: r.logFile })
    : Response.json({ error: r.reason }, { status: 409 });
}
