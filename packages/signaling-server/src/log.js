// packages/signaling-server/src/log.js
// Single-line JSON logger. Callers MUST pass only non-sensitive fields
// (ids, reasons, counts) — never passwords or SDP.
export function createLogger({ sink = console.log, now = () => new Date().toISOString() } = {}) {
  return {
    event(name, fields = {}) {
      sink(JSON.stringify({ ts: now(), event: name, ...fields }));
    },
  };
}
