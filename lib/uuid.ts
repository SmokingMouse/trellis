// Client-safe UUID generator that also works outside a secure context.
//
// `crypto.randomUUID()` is only defined in a secure context (https or
// localhost). Trellis binds 0.0.0.0 and is meant to be reached over the LAN
// or a tunnel, so a remote client on a plain-http origin (e.g.
// http://192.168.x.x:3088) has `crypto.randomUUID === undefined` — calling it
// throws synchronously and kills whatever it's in (an optimistic-node id here
// meant that a submit died before it could even fetch).
//
// `crypto.getRandomValues()` is NOT secure-context-gated (unlike randomUUID /
// subtle), so it's the right fallback: still a real v4 UUID, still
// cryptographic-quality randomness, works over plain http. Math.random is only
// the last resort for environments missing Web Crypto entirely.
//
// Node (server-side callers) always has crypto.randomUUID, so this returns the
// native value there — safe to use anywhere, client or server.
export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
