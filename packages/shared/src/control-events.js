// packages/shared/src/control-events.js
export const CONTROL = Object.freeze({
  LIST_MONITORS: 'list_monitors',
  MONITORS: 'monitors',
  SELECT_MONITOR: 'select_monitor',
  SESSION_END: 'session_end',
  // Host → controller: the host is ending the session (Disconnect button, panic
  // key, or timeout). Lets the controller show a clear "session ended" message
  // instead of interpreting the peer drop as a transient loss and reconnecting.
  HOST_ENDED: 'host_ended',
});

const fail = () => { throw new Error('invalid control event'); };
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const isPosInt = (n) => Number.isInteger(n) && n > 0;

function sanitizeMonitor(m) {
  if (!m || typeof m !== 'object') fail();
  if (!isInt(m.index, 0, 15) || typeof m.label !== 'string' || m.label.length < 1 || m.label.length > 64) fail();
  if (!isPosInt(m.width) || !isPosInt(m.height) || typeof m.primary !== 'boolean') fail();
  return { index: m.index, label: m.label, width: m.width, height: m.height, primary: m.primary };
}

export function validateControlEvent(evt) {
  if (!evt || typeof evt !== 'object') fail();
  switch (evt.type) {
    case CONTROL.LIST_MONITORS:
      return { type: evt.type };
    case CONTROL.MONITORS:
      if (!Array.isArray(evt.monitors) || evt.monitors.length < 1 || evt.monitors.length > 16) fail();
      return { type: evt.type, monitors: evt.monitors.map(sanitizeMonitor) };
    case CONTROL.SELECT_MONITOR:
      if (!isInt(evt.index, 0, 15)) fail();
      return { type: evt.type, index: evt.index };
    case CONTROL.SESSION_END:
    case CONTROL.HOST_ENDED:
      if (evt.reason !== undefined && (typeof evt.reason !== 'string' || evt.reason.length > 32)) fail();
      return evt.reason !== undefined ? { type: evt.type, reason: evt.reason } : { type: evt.type };
    default:
      return fail();
  }
}
