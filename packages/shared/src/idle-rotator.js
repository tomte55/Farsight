// packages/shared/src/idle-rotator.js
// Rotates a session password on an idle interval. Paused while a session is
// active/pending so the password never changes mid-connect; resumeAfterSession
// rotates immediately (a fresh password after every session) and re-arms.
// Injected timers mirror packages/host/src/timeouts.js for testability.
export function createIdleRotator({
  intervalMs,
  onRotate,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let timer = null;
  let paused = false;
  let started = false;
  const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const arm = () => { disarm(); timer = setTimeout(fire, intervalMs); };
  function fire() { timer = null; onRotate(); arm(); }
  return {
    start() { started = true; paused = false; arm(); },
    pause() { paused = true; disarm(); },
    resumeAfterSession() {
      if (!started) return;
      const wasPaused = paused;
      paused = false;
      if (wasPaused) onRotate();
      arm();
    },
    kick() { if (started && !paused) arm(); },
    stop() { started = false; disarm(); },
  };
}
