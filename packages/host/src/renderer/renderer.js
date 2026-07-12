// packages/host/src/renderer/renderer.js
import { createSignalingClient } from '../signaling-client.js';
import { createHostPeer } from '../peer.js';
import { createSession } from '../session.js';
import { createSessionTimers } from '../timeouts.js';
import { monitorsForControl } from '../capture.js';
import { MSG } from '@farsight/shared/protocol';
import { CONTROL, validateControlEvent } from '@farsight/shared/control-events';

const idEl = document.getElementById('host-id');
const statusEl = document.getElementById('status');
const consentEl = document.getElementById('consent');
const bannerEl = document.getElementById('banner');
const appEl = document.querySelector('.app');
const updateBanner = document.getElementById('update-banner');
const updateMsg = document.getElementById('update-msg');
const menuStatus = document.getElementById('menu-status');

window.farsightIpc.onUpdateStatus((ui) => {
  updateBanner.classList.toggle('show', ui.showRestartPrompt);
  updateMsg.textContent = ui.showRestartPrompt ? `Update available (${ui.version})` : '';
  menuStatus.textContent = ui.message || '';
});
document.getElementById('update-restart').addEventListener('click', (e) => { e.preventDefault(); window.farsightIpc.installUpdate(); });

// Settings cogwheel menu (top-right): toggle on click, dismiss on outside click.
const settingsCog = document.getElementById('settings-cog');
const settingsMenu = document.getElementById('settings-menu');
settingsCog.addEventListener('click', (e) => { e.stopPropagation(); settingsMenu.classList.toggle('open'); });
document.addEventListener('click', (e) => { if (!settingsMenu.contains(e.target) && e.target !== settingsCog) settingsMenu.classList.remove('open'); });
document.getElementById('menu-check-updates').addEventListener('click', () => window.farsightIpc.checkForUpdates());

// Copy buttons on the ID/password chips (clipboard is allowed in the renderer).
for (const btn of document.querySelectorAll('.cbtn')) {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1200); } catch { /* ignore */ }
  });
}
let peer = null;
let signal = null;
let displays = [];
let currentStream = null;
let iceServers = []; // R-1: received via ICE_SERVERS (after the controller authenticates)
let timers = null;

async function getStreamForDisplay(display) {
  // desktopCapturer runs in main; renderer asks for the source id for the given
  // monitor, then uses getUserMedia to capture it.
  const sourceId = await window.farsightIpc.getScreenSourceFor(display.id);
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30,
    } },
  });
}

// The controller sends CONNECT then immediately its OFFER (and ICE candidates),
// but the host does not build its peer until the user grants consent — which
// can take several seconds. Buffer the early offer/candidates and apply them
// once the peer exists and the remote description is set; otherwise they would
// be silently dropped and the session would hang with no video.
let remoteReady = false;
let pendingOffer = null;
const pendingCandidates = [];

function flushCandidates() {
  while (pendingCandidates.length) peer.handleCandidate(pendingCandidates.shift());
}

// Full teardown: stop screen capture (releases the OS capture indicator), close
// the peer, and clear buffered signaling. Used by deny/cut/panic/peer-disconnect
// and controller-initiated SESSION_END.
function teardown() {
  if (currentStream) { currentStream.getTracks().forEach((t) => t.stop()); currentStream = null; }
  if (peer) { peer.close(); peer = null; }
  if (timers) { timers.stop(); timers = null; }
  remoteReady = false;
  pendingOffer = null;
  pendingCandidates.length = 0;
}

// End an active session that the HOST initiated (Disconnect button, panic,
// timeout). Notify the controller over the reliable control channel first so it
// shows a clear "session ended" message instead of trying to reconnect, then
// tear down. A short flush delay lets the ordered channel deliver the message
// before the peer closes; panic tears down immediately (physical override wins).
function endSessionByHost(reason, statusText, { immediate = false } = {}) {
  if (peer) { try { peer.sendControl({ type: CONTROL.HOST_ENDED, reason }); } catch { /* channel gone */ } }
  session.end();
  statusEl.textContent = statusText;
  if (immediate || !peer) teardown();
  else setTimeout(teardown, 150);
}

// Consent gate: nothing is captured or streamed until the user clicks Allow.
const session = createSession({
  onStateChange: (st) => {
    window.farsightIpc.setSessionActive(st === 'active');
    consentEl.style.display = st === 'pending_consent' ? 'block' : 'none';
    document.getElementById('idle').style.display = (st === 'pending_consent' || st === 'active') ? 'none' : 'block';
    bannerEl.style.display = st === 'active' ? 'flex' : 'none';
    document.body.classList.toggle('in-session', st === 'active');
  },
});

async function onControl(raw) {
  let evt;
  try { evt = validateControlEvent(raw); } catch { return; }
  if (evt.type === CONTROL.LIST_MONITORS) {
    peer && peer.sendControl({ type: CONTROL.MONITORS, monitors: monitorsForControl(displays) });
  } else if (evt.type === CONTROL.SELECT_MONITOR) {
    const d = displays[evt.index];
    if (!d || !peer) return;
    const newStream = await getStreamForDisplay(d);
    await peer.replaceVideoTrack(newStream.getVideoTracks()[0]);
    if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
    currentStream = newStream;
    await window.farsightIpc.selectInjectorDisplay(d.index);
  } else if (evt.type === CONTROL.SESSION_END) {
    session.end();
    teardown();
    statusEl.textContent = 'Session ended by controller.';
  }
}

async function startSession() {
  displays = await window.farsightIpc.listDisplays();
  const primary = displays.find((d) => d.primary) ?? displays[0];
  currentStream = await getStreamForDisplay(primary);
  await window.farsightIpc.selectInjectorDisplay(primary.index);
  peer = createHostPeer({
    stream: currentStream,
    iceServers,
    sendSignal: (type, payload) => signal.send(type, payload),
    // Input injection runs in the main process. Only forward while the session
    // is active — a second layer over the consent gate. Each event counts as
    // activity so an actively-used session doesn't hit the idle timeout.
    onInput: (evt) => { if (session.isActive()) { window.farsightIpc.injectInput(evt); if (timers) timers.activity(); } },
    onControl: (evt) => onControl(evt),
  });
  // Auto-end the session on inactivity (idle) or after a hard cap (absolute).
  timers = createSessionTimers({
    idleMs: 10 * 60 * 1000,
    absoluteMs: 8 * 60 * 60 * 1000,
    onExpire: (reason) => { endSessionByHost(`${reason}_timeout`, `Session ended (${reason} timeout).`); },
  });
  timers.start();
  if (pendingOffer) {
    await peer.handleOffer(pendingOffer);
    pendingOffer = null;
    remoteReady = true;
    flushCandidates();
  }
}

document.getElementById('allow').addEventListener('click', async () => {
  session.allow();
  statusEl.textContent = 'Session active.';
  await startSession();
});
document.getElementById('deny').addEventListener('click', () => {
  session.deny();
  teardown();
  statusEl.textContent = 'Request denied. Waiting for a controller.';
});
document.getElementById('cut').addEventListener('click', () => {
  endSessionByHost('disconnect', 'Session ended.');
});

// Panic hotkey (Ctrl/Cmd+Alt+F12) fires from the main process — instantly kill
// any session. The physical override always wins.
window.farsightIpc.onPanic(() => {
  endSessionByHost('panic', 'Session ended by panic key.', { immediate: true });
});

// The session password is generated in the main process (node:crypto) and shown
// here; it is sent on REGISTER so the signaling server can gate controllers.
const sessionPassword = await window.farsightIpc.getSessionPassword();
document.getElementById('host-pw').textContent = sessionPassword;

function startSignaling(signalingUrl) {
  signal = createSignalingClient(signalingUrl, {
    [MSG.REGISTERED]: (m) => { idEl.textContent = m.id; window.farsightIpc.setHostId(m.id); statusEl.textContent = 'Ready. Waiting for a controller.'; },
    // R-1: the server sends ICE servers right before CONNECT, only after the
    // controller authenticated. Store them for the peer built on consent.
    [MSG.ICE_SERVERS]: (m) => { iceServers = m.iceServers || []; },
    [MSG.CONNECT]: () => { session.requestConsent(); window.farsightIpc.requestAttention(); statusEl.textContent = 'A controller wants to connect.'; },
    [MSG.OFFER]: async (m) => {
      if (peer) { await peer.handleOffer(m.sdp); remoteReady = true; flushCandidates(); }
      else { pendingOffer = m.sdp; }
    },
    [MSG.CANDIDATE]: (m) => {
      if (peer && remoteReady) peer.handleCandidate(m.candidate);
      else pendingCandidates.push(m.candidate);
    },
    [MSG.PEER_DISCONNECTED]: () => {
      teardown();
      session.end();
      statusEl.textContent = 'Peer disconnected.';
    },
  }, { password: sessionPassword });
}

// First-run setup / settings: the signaling URL is configured via IPC, never
// baked in. No configured URL yet -> show the setup screen and do not
// register with any signaling server until the user saves one.
const setupEl = document.getElementById('setup');
const urlInput = document.getElementById('signaling-url');
const setupError = document.getElementById('setup-error');

async function saveSignaling() {
  const res = await window.farsightIpc.setSignalingUrl(urlInput.value);
  if (res.ok) { location.reload(); }
  else { setupError.textContent = res.error; }
}
document.getElementById('save-signaling').addEventListener('click', saveSignaling);
document.getElementById('menu-change-server').addEventListener('click', async () => {
  settingsMenu.classList.remove('open');
  urlInput.value = (await window.farsightIpc.getSignalingUrl()) || '';
  appEl.style.display = 'none';      // hide the normal host view while setup is up
  setupEl.hidden = false;
});

const signalingUrl = await window.farsightIpc.getSignalingUrl();
if (!signalingUrl) {
  appEl.style.display = 'none';      // first run: hide the normal host view...
  setupEl.hidden = false;            // ...and show setup; do not register
} else {
  appEl.style.display = 'block';
  setupEl.hidden = true;
  startSignaling(signalingUrl);
}
