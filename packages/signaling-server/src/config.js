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
    // H-1: only trust X-Forwarded-For when explicitly behind a trusted proxy.
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    // L-2: per-socket message rate limit (generous — ICE candidate bursts are normal).
    msgBurst: Number(env.MSG_BURST ?? 60),
    msgPerSec: Number(env.MSG_PER_SEC ?? 30),
    // L-1: per-source-IP CONNECT budget, to blunt the host-enumeration oracle.
    // Every CONNECT (offline/bad-password/SUCCESS alike) spends one and it is
    // never refunded on success — so this ALSO bounds how many parallel transfer
    // flows one sender can open per window. LINKED TO MAX_PARALLEL_CONNECTIONS
    // (@farsight/shared/config, 32): this default (30) is BELOW that ceiling, so a
    // high-flow send self-rate-limits. Raising this weakens enumeration protection;
    // the preferred fix is capping flows client-side (Phase 2.4), not raising this.
    connectBurst: Number(env.CONNECT_BURST ?? 30),
    // SP3 (spec §4.1): sweep a transfer session whose target never attaches.
    sessionTimeoutMs: Number(env.SESSION_TIMEOUT_MS ?? 15000),
  };
}
