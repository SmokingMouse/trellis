// Herdr 控制台推送的客户端决策（纯函数，便于单测）。

/** /api/events `herdr` 通道的帧，见 lib/server/console-events.ts。 */
export type HerdrChangeEvent = {
  type: "changed";
  fleetEtag: string | null;
  hooksEtag: string | null;
  kinds?: string[];
};

export type HerdrFetchPlan = { fleet: boolean; hooks: boolean };

/** 推送流在线时轮询只是兜底；断流时回到原来的 2.5s。 */
export const HERDR_POLL_CONNECTED_MS = 30_000;
export const HERDR_POLL_DISCONNECTED_MS = 2_500;

export function herdrPollInterval(connected: boolean): number {
  return connected ? HERDR_POLL_CONNECTED_MS : HERDR_POLL_DISCONNECTED_MS;
}

/**
 * 推送来的 ETag 与本地持有的比：哪半边变了就拉哪半边；都没变返回 null。
 * 服务端算不出 ETag（null）时保守地拉一次。
 */
export function herdrFetchPlan(
  change: HerdrChangeEvent | null | undefined,
  local: { fleetEtag: string | null; hooksEtag: string | null },
): HerdrFetchPlan | null {
  if (!change || change.type !== "changed") return null;
  const fleet = change.fleetEtag === null || change.fleetEtag !== local.fleetEtag;
  const hooks = change.hooksEtag === null || change.hooksEtag !== local.hooksEtag;
  return fleet || hooks ? { fleet, hooks } : null;
}
