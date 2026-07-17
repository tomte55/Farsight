// packages/controller/src/timeouts.js
export function createSessionTimers({ idleMs, absoluteMs, onExpire, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  let idleTimer = null; let absTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => onExpire('idle'), idleMs);
  };
  return {
    start() {
      armIdle();
      absTimer = setTimeout(() => onExpire('absolute'), absoluteMs);
    },
    activity() { armIdle(); },
    stop() { if (idleTimer) clearTimeout(idleTimer); if (absTimer) clearTimeout(absTimer); idleTimer = absTimer = null; },
  };
}
