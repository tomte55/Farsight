// packages/host/src/session.js
// Verbose diagnostic logging (see docs/private/superpowers): never log the
// session password, SDP/ICE, clipboard text, or keystroke values.
function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

export function createSession({ onStateChange, log = noopLog() }) {
  let state = 'idle';
  const set = (next) => {
    state = next;
    if (next === 'active') log.info('session started');
    else if (next === 'ended') log.info('session stopped');
    onStateChange(next);
  };
  return {
    get state() { return state; },
    requestConsent() { if (state === 'idle') set('pending_consent'); },
    allow() { if (state === 'pending_consent') set('active'); },
    deny() { if (state === 'pending_consent') set('idle'); },
    end() { set('ended'); set('idle'); },
    isActive() { return state === 'active'; },
  };
}
