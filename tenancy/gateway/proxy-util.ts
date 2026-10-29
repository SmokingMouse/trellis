import { SESSION_COOKIE } from "./auth";

/** 当前选中的 node（hub 多机切换）。网关自己的 cookie，不转发给实例。 */
export const NODE_COOKIE = "trellis_node";

export function readCookie(raw: string | null, name: string): string | null {
  for (const part of (raw || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function translatedCookie(raw: string | null, authToken: string): string {
  const kept = (raw || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split("=", 1)[0];
      return part && name !== SESSION_COOKIE && name !== NODE_COOKIE && name !== "trellis_auth";
    });
  kept.push(`trellis_auth=${authToken}`);
  return kept.join("; ");
}

export function upstreamHeaders(
  source: Headers,
  authority: string,
  authToken: string,
): Headers {
  const headers = new Headers(source);
  const originalHost = source.get("host");
  if (originalHost && !source.has("x-forwarded-host")) {
    headers.set("x-forwarded-host", originalHost);
  }
  headers.set("host", authority);
  headers.set("cookie", translatedCookie(source.get("cookie"), authToken));
  headers.delete("connection");
  headers.delete("upgrade");
  return headers;
}

export function responseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
}
