import { startTtyd, ttydStatus } from "@/lib/server/ttyd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 内部接口：只给大门（server.ts）问「ttyd 现在监听在哪」。
//
// ttyd 的生命周期归 Next 进程里的 lib/server/ttyd.ts（懒启动、孤儿收尸），
// 而转发终端流量的是大门那个 Bun.serve —— 两者在不同进程，所以要有这么一问。
//
// **不对外**：proxy.ts 的 cookie 闸盖着 /api/*，外部请求过不来；
// 大门自己发的请求走 127.0.0.1 且带 x-trellis-internal 头。
export async function GET() {
  await startTtyd();
  const { port, error } = ttydStatus();
  return Response.json({ port, error });
}
