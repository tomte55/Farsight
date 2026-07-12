// packages/host/src/session.js
export function createSession({ onStateChange }) {
  let state = 'idle';
  const set = (next) => { state = next; onStateChange(next); };
  return {
    get state() { return state; },
    requestConsent() { if (state === 'idle') set('pending_consent'); },
    allow() { if (state === 'pending_consent') set('active'); },
    deny() { if (state === 'pending_consent') set('idle'); },
    end() { set('ended'); set('idle'); },
    isActive() { return state === 'active'; },
  };
}
