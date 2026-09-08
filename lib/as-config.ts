export function isAgentServerEnabled(env: Record<string, string | undefined> = process.env) {
  if (env.TRELLIS_AS === "off") return false;
  return env.TRELLIS_AS === "on" || Boolean(env.TRELLIS_AS_SOCKET);
}

export function isAdoptEnabled(env: Record<string, string | undefined> = process.env) {
  return isAgentServerEnabled(env) && env.TRELLIS_AS_ADOPT === "on";
}
