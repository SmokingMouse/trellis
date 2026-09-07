export function isShadowEnabled(env: { TRELLIS_AS?: string; TRELLIS_AS_SOCKET?: string } = process.env) {
  return env.TRELLIS_AS === "on" || Boolean(env.TRELLIS_AS_SOCKET);
}
