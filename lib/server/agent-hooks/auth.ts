// hook 端点的口令校验（/api/hooks/claude 与 /api/hooks/claude/interaction 共用）。
// 来客是 Claude Code 拉起的 sh，没有浏览器 cookie，只能带 X-Trellis-Hook-Token。
import { createHash, timingSafeEqual } from "node:crypto";
import { readHookToken } from "./endpoint";

export const HOOK_TOKEN_HEADER = "x-trellis-hook-token";

/**
 * 常量时间比对。先各自 sha256 再比 —— 直接比字符串会按长度早退，
 * 而 timingSafeEqual 要求等长（长度不同会抛，本身也是一次泄漏）。
 */
export function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 校验不过 → 应答（503 没开 / 401 口令错）；过了 → null。 */
export function rejectHookRequest(req: Request): Response | null {
  const expected = readHookToken();
  if (!expected) {
    // 端点文件还没写（TRELLIS_HOOKS=off 或启动钩子失败）= 这个口没开。
    return Response.json({ error: "hooks not enabled" }, { status: 503 });
  }
  const given = req.headers.get(HOOK_TOKEN_HEADER) ?? "";
  if (!given || !tokenMatches(given, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
