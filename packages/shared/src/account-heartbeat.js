// packages/shared/src/account-heartbeat.js
// Client-side presence heartbeat (SP2 S2.5, Option D — see
// specs/2026-07-14-sp2-presence-design.md). A signed-in app periodically reports
// its own liveness + app version to the account server (POST /devices/heartbeat)
// so the owner's fleet console shows it online with the right version. Presence
// lives wholly in the account server; the signaling server is untouched.
//
// Pure and runtime-agnostic: the session (for a fresh access token), the account
// client, and the scheduler are injected. The account server's online window is
// 90s, so the default interval (30s) is comfortably shorter. A skipped beat (no
// usable token) or a failed request never throws out of a tick, so a transient
// sign-out or network blip doesn't kill the loop — it recovers on the next beat.
//
// Verbose diagnostic logging (see docs/private/superpowers): ok/fail + HTTP
// status only — never the access token.
function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

export function createHeartbeat({
  session,
  client,
  version,
  getSignalingId,
  onDirective,
  intervalMs = 30_000,
  setInterval: setI,
  clearInterval: clearI,
  log = noopLog(),
} = {}) {
  const schedule = setI ?? (typeof setInterval !== 'undefined' ? setInterval : null);
  const cancel = clearI ?? (typeof clearInterval !== 'undefined' ? clearInterval : null);
  if (!schedule || !cancel) throw new Error('createHeartbeat: no scheduler available');

  let handle = null;

  // One heartbeat. Never throws: a signed-out session or a network/HTTP error is
  // swallowed so the interval keeps firing and recovers when the session resumes.
  async function beat() {
    try {
      const token = await session.getAccessToken();
      if (!token) return;
      // Connect-from-console rendezvous: report the current signaling id so the
      // owner's console knows where to dial this device (undefined → omitted).
      const signalingId = getSignalingId ? getSignalingId() : undefined;
      const res = await client.heartbeat({ accessToken: token, version, signalingId: signalingId || undefined });
      if (res && res.ok) log.debug('heartbeat ok');
      else if (res) log.warn(`heartbeat failed status=${res.status}`);
      // Surface any management directive in the response (S2.7: a converge-to
      // target version) so the app can act on it. Best-effort; never throws.
      if (onDirective && res && res.ok && res.data) {
        try { onDirective(res.data); } catch { /* ignore */ }
      }
    } catch {
      // swallow — the next tick tries again
    }
  }

  return {
    // Start beating immediately, then every intervalMs. Idempotent while running.
    async start() {
      if (handle === null) handle = schedule(() => { beat(); }, intervalMs);
      await beat();
    },
    // Stop beating. Restartable via start().
    stop() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
    },
    // Exposed for a manual/immediate beat (and tests).
    beat,
  };
}
