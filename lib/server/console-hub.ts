import "server-only";
import { ConsoleHub, installConsoleHub } from "./console-events";
import { getHerdrFleetService } from "./herdr-fleet";
import { hookStateSnapshot } from "./agent-hooks/store";
import { subscribeCliSync } from "./cli-sync-events";

/**
 * 首个 /api/events 连接进来时接线一次（进程级单例）：
 *   Herdr socket 变化（含输入投递回执）→ "herdr"
 *   镜像 jsonl 重导完成（transcript 待答 / 绑定可能变）→ "transcript"
 *   hook 写入由 /api/hooks/claude 直接 notifyConsoleChange("hook")。
 */
export function ensureConsoleHub(): ConsoleHub {
  return installConsoleHub(() => {
    const fleet = getHerdrFleetService();
    void fleet.ensureStarted();
    const hub = new ConsoleHub({
      fleetEtag: () => fleet.etag(),
      hooksEtag: () => hookStateSnapshot().etag,
    });
    fleet.subscribe(() => hub.notify("herdr"));
    subscribeCliSync({
      onEvent: (event) => { if (event.type === "session_updated") hub.notify("transcript"); },
      onClose: () => {},
    });
    return hub;
  });
}
