// packages/signaling-server/src/config.js
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8080),
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 5),
    windowMs: Number(env.LOCKOUT_WINDOW_MS ?? 60000),
    turnSecret: env.TURN_SECRET ?? '',
    turnTtlSeconds: Number(env.TURN_TTL_SECONDS ?? 3600),
    turnUri: env.TURN_URI ?? '',
    turnsUri: env.TURNS_URI ?? '', // optional TLS TURN url (turns:...:5349)
  };
}
