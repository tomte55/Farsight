// packages/controller/src/session-overlay.js
// Pure mapping of (RTCPeerConnection connectionState, optional reason) to the
// in-session overlay shown ON TOP of the video. Both the peer's
// onConnectionState and the signaling PEER_DISCONNECTED handler feed this, so a
// message is always visible during a session (the old status element was hidden
// while the video was showing).
const HIDDEN = { visible: false, kind: 'hidden', title: '', actions: [] };
const CONNECTING = { visible: true, kind: 'connecting', title: 'Connecting…', actions: [] };
const RECONNECTING = { visible: true, kind: 'reconnecting', title: 'Reconnecting…', actions: [] };
const DISCONNECTED = {
  visible: true,
  kind: 'disconnected',
  title: 'Host disconnected',
  actions: [
    { id: 'reconnect', label: 'Reconnect' },
    { id: 'close', label: 'Close session' },
  ],
};
// The host intentionally ended the session (Disconnect/panic/timeout) — a calm,
// terminal state, not an error. The host stays registered, so Reconnect is offered.
const HOST_ENDED = {
  visible: true,
  kind: 'ended',
  title: 'Session ended',
  actions: [
    { id: 'reconnect', label: 'Reconnect' },
    { id: 'close', label: 'Close session' },
  ],
};

export function sessionOverlayFor(connState, reason) {
  if (reason === 'host_ended') return HOST_ENDED;
  if (reason === 'peer_disconnected') return DISCONNECTED;
  switch (connState) {
    case 'new':
    case 'connecting':
    case 'checking':
      return CONNECTING;
    case 'connected':
      return HIDDEN;
    case 'disconnected':
      return RECONNECTING;
    case 'failed':
    case 'closed':
      return DISCONNECTED;
    default:
      return HIDDEN;
  }
}
