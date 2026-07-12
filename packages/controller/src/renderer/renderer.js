// packages/controller/src/renderer/renderer.js
import { createSignalingClient } from '../signaling-client.js';
import { createControllerPeer, describeConnectionState } from '../peer.js';
import { domEventToInput } from '../input-capture.js';
import { MSG } from '@farsight/shared/protocol';
import { CONTROL } from '@farsight/shared/control-events';
import { isValidHostId } from '@farsight/shared/host-id';
import { sessionOverlayFor } from '../session-overlay.js';

const idInput = document.getElementById('host-id');
const statusEl = document.getElementById('status');
const connectEl = document.getElementById('connect-wrap');
const screenEl = document.getElementById('screen');
const video = document.getElementById('video');
const setupEl = document.getElementById('setup');
const urlInput = document.getElementById('signaling-url');
const setupError = document.getElementById('setup-error');
let signalingUrl = null;
let peer = null, signal = null;
const overlayEl = document.getElementById('overlay');
const lastCreds = { targetId: '', password: '' };
let inputWired = false;
// Set when the host tells us it ended the session (HOST_ENDED). Suppresses the
// transient-disconnect/reconnect path so the terminal "Session ended" overlay
// isn't overwritten by the peer-close connectionstatechange that follows.
let sessionClosing = false;
// Session-active signal for the auto-updater: true while the remote screen is
// showing, false at every teardown path (host-ended, peer-disconnected,
// Disconnect). Keeps a pending update prompt from firing mid-session.
const setActive = (v) => window.farsightIpc.setSessionActive(v);

const updateBanner = document.getElementById('update-banner');
const updateMsg = document.getElementById('update-msg');
const updateStatus = document.getElementById('update-status');

window.farsightIpc.onUpdateStatus((ui) => {
  updateBanner.hidden = !ui.showRestartPrompt;
  updateMsg.textContent = ui.showRestartPrompt ? ui.message : '';
  updateStatus.textContent = ui.message || '';
});
document.getElementById('update-restart').addEventListener('click', () => window.farsightIpc.installUpdate());
document.getElementById('check-updates').addEventListener('click', () => window.farsightIpc.checkForUpdates());

async function refreshSignalingUrl() {
  signalingUrl = await window.farsightIpc.getSignalingUrl();
  const configured = !!signalingUrl;
  setupEl.hidden = configured;
  connectEl.style.display = configured ? '' : 'none';
}
async function saveSignaling() {
  const res = await window.farsightIpc.setSignalingUrl(urlInput.value);
  if (res.ok) { setupError.textContent = ''; await refreshSignalingUrl(); }
  else { setupError.textContent = res.error; }
}
document.getElementById('save-signaling').addEventListener('click', saveSignaling);
document.getElementById('open-settings').addEventListener('click', async () => {
  urlInput.value = (await window.farsightIpc.getSignalingUrl()) || '';
  connectEl.style.display = 'none';
  setupEl.hidden = false;
});
refreshSignalingUrl();

const ERROR_TEXT = {
  host_offline: 'Host is offline.',
  bad_password: 'Wrong password.',
  locked: 'Too many attempts — locked. Try later.',
  busy: 'Host is in another session.',
  rate_limited: 'Too many connections — try again shortly.',
};

// Render the in-session overlay from the pure sessionOverlayFor() decision.
// Lives ON TOP of the video (position:fixed) so it's visible during a session.
function showOverlay(connState, reason) {
  const o = sessionOverlayFor(connState, reason);
  if (!o.visible) { overlayEl.hidden = true; return; }
  const glyphs = { disconnected: '⚠', ended: '⏹', reconnecting: '…', connecting: '…' };
  const details = {
    disconnected: `The connection to ${lastCreds.targetId || 'the host'} was lost.`,
    ended: 'The host ended the session.',
    reconnecting: 'Trying to restore the connection…',
  };
  document.getElementById('ov-glyph').textContent = glyphs[o.kind] || '…';
  document.getElementById('ov-glyph').style.background =
    o.kind === 'disconnected' ? 'rgba(255,143,163,.15)' : 'rgba(124,92,255,.15)';
  document.getElementById('ov-title').textContent = o.title;
  document.getElementById('ov-detail').textContent = details[o.kind] || '';
  const actions = document.getElementById('ov-actions');
  actions.innerHTML = '';
  for (const a of o.actions) {
    const b = document.createElement('button');
    b.className = a.id === 'reconnect' ? 'btn btn-primary' : 'btn btn-ghost';
    b.textContent = a.label;
    b.onclick = a.id === 'reconnect' ? doReconnect : doClose;
    actions.appendChild(b);
  }
  overlayEl.hidden = false;
}

function doClose() {
  if (peer) { peer.close(); peer = null; }
  if (signal) { signal.close && signal.close(); signal = null; }
  overlayEl.hidden = true;
  screenEl.style.display = 'none';
  connectEl.style.display = '';
  statusEl.textContent = '';
  setActive(false);
}

function doReconnect() {
  if (peer) { peer.close(); peer = null; }
  if (signal) { signal.close && signal.close(); signal = null; }
  overlayEl.hidden = true;
  idInput.value = lastCreds.targetId;
  document.getElementById('host-pw').value = lastCreds.password;
  document.getElementById('go').click();
}

document.getElementById('go').addEventListener('click', async () => {
  if (!signalingUrl) return;
  const targetId = idInput.value.trim();
  const password = document.getElementById('host-pw').value.trim();
  lastCreds.targetId = targetId;
  lastCreds.password = password;
  sessionClosing = false; // fresh attempt — clear any prior host-ended state
  if (!isValidHostId(targetId)) { statusEl.textContent = 'Invalid ID.'; return; }
  if (!password) { statusEl.textContent = 'Enter the host password.'; return; }
  statusEl.textContent = 'Connecting…';

  // R-1: the server issues ICE/TURN servers only after successful auth. Build
  // the peer (and offer) once they arrive so the connection can use TURN.
  const startPeer = (iceServers) => {
    const thisPeer = createControllerPeer({
      sendSignal: (type, payload) => signal.send(type, payload),
      iceServers,
      onConnectionState: (s) => {
        if (peer !== thisPeer) return; // ignore callbacks from a replaced/closed peer
        if (sessionClosing) return; // host ended it — keep the terminal overlay
        statusEl.textContent = describeConnectionState(s);
        // Only drive the overlay once the session view is up (video showing).
        if (screenEl.style.display === 'block') showOverlay(s);
      },
      // The host enumerates its monitors over the reliable control channel; build
      // the picker and send SELECT_MONITOR when the user switches.
      onControl: (evt) => {
        if (evt.type === CONTROL.MONITORS) {
          const sel = document.getElementById('monitors');
          sel.innerHTML = '';
          for (const m of evt.monitors) {
            const o = document.createElement('option');
            o.value = String(m.index);
            o.textContent = `${m.label} (${m.width}×${m.height})${m.primary ? ' • primary' : ''}`;
            sel.appendChild(o);
          }
          sel.style.display = evt.monitors.length > 1 ? 'inline-block' : 'none';
          sel.onchange = () => peer.sendControl({ type: CONTROL.SELECT_MONITOR, index: Number(sel.value) });
        } else if (evt.type === CONTROL.HOST_ENDED) {
          // The host ended the session on purpose. Close our peer (so no ICE
          // restart fires) and show the terminal "Session ended" overlay instead
          // of the reconnect flow.
          sessionClosing = true;
          setActive(false);
          if (peer) { peer.close(); peer = null; }
          if (screenEl.style.display === 'block') showOverlay(null, 'host_ended');
        }
      },
      onTrack: (stream) => {
        video.srcObject = stream;
        setActive(true);
        connectEl.style.display = 'none';
        screenEl.style.display = 'block';
        document.getElementById('end').onclick = doClose;
        // Forward mouse/keyboard over the input data channel. Registered once
        // (onTrack can fire again on Reconnect); the handler reads the current
        // module-level `peer` and no-ops when there is none (e.g. after Close).
        if (!inputWired) {
          const forward = (e) => {
            if (!peer) return;
            if (['mousedown', 'mouseup', 'wheel'].includes(e.type)) e.preventDefault();
            const rect = video.getBoundingClientRect();
            const evt = domEventToInput(e, rect);
            if (evt) peer.sendInput(evt);
          };
          for (const t of ['mousemove', 'mousedown', 'mouseup', 'wheel']) video.addEventListener(t, forward, { passive: false });
          for (const t of ['keydown', 'keyup']) window.addEventListener(t, forward);
          inputWired = true;
        }
      },
    });
    peer = thisPeer;
    peer.start();
  };

  signal = createSignalingClient(signalingUrl, {
    [MSG.ICE_SERVERS]: (m) => startPeer(m.iceServers || []),
    [MSG.ANSWER]: (m) => peer.handleAnswer(m.sdp),
    [MSG.CANDIDATE]: (m) => peer.handleCandidate(m.candidate),
    [MSG.ERROR]: (m) => { statusEl.textContent = ERROR_TEXT[m.reason] || `Error: ${m.reason}`; },
    [MSG.PEER_DISCONNECTED]: () => {
      setActive(false);
      if (sessionClosing) return; // host already told us it ended — keep that overlay
      if (screenEl.style.display === 'block') showOverlay(null, 'peer_disconnected');
      else { statusEl.textContent = 'Host disconnected.'; connectEl.style.display = ''; }
    },
  });

  await signal.ready;
  // Host reacts to CONNECT (prepares its stream). On success the server sends
  // ICE_SERVERS, which triggers peer creation + OFFER above.
  signal.send(MSG.CONNECT, { targetId, password });
});
