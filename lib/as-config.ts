export function isShadowEnabled(env: Record<string, string | undefined> = process.env) {
  return env.TRELLIS_AS === "on" || Boolean(env.TRELLIS_AS_SOCKET);
}
