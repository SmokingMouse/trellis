export function isShadowEnabled(env: Record<string, string | undefined> = process.env) {
  if (env.TRELLIS_AS === "off") return false;
  return env.TRELLIS_AS === "on" || Boolean(env.TRELLIS_AS_SOCKET);
}
