// packages/host/src/renderer/renderer.js
import { createSignalingClient } from '../signaling-client.js';
import { createHostPeer } from '../peer.js';
import { createSession } from '../session.js';
import { createSessionTimers } from '../timeouts.js';
import { monitorsForControl } from '../capture.js';
import { MSG } from '@farsight/shared/protocol';
import { CONTROL, validateControlEvent } from '@farsight/shared/control-events';
import {
  CHUNK_SIZE, MAX_FILE_SIZE, metaFrame, endFrame, parseFrame, sanitizeFilename, createReceiver,
} from '@farsight/shared/file-transfer';
import { formatHostId } from '@farsight/shared/credentials-format';
import { createIdleRotator } from '@farsight/shared/idle-rotator';

// Bound on receiveState.chunks.length: legit transfers use CHUNK_SIZE chunks
// (~6400 for a 100 MB file), so this bounds the array against a peer sending
// a huge number of tiny chunks (O(n^2) reduce + per-ArrayBuffer overhead) even
// though each one is individually within the total-byte cap.
const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE) + 16;

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
for (const btn of document.querySelectorAll('.cbtn[data-copy]')) {
  btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    const text = el.dataset.copyValue || el.textContent;
    try { await navigator.clipboard.writeText(text); const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1200); } catch { /* ignore */ }
  });
}
let peer = null;
let signal = null;
let rotator = null;
const PW_ROTATE_MS = 60 * 60 * 1000; // rotate the session password hourly while idle
const pwEl = document.getElementById('host-pw');
// Rotate the on-screen session password and push it to the signaling server so
// the server accepts the new value. Used by the manual button and the idle timer.
async function rotatePassword() {
  const next = await window.farsightIpc.regenerateSessionPassword();
  pwEl.textContent = next;
  if (signal) signal.send(MSG.UPDATE_PASSWORD, { password: next });
}
document.getElementById('regen-pw').addEventListener('click', async () => {
  await rotatePassword();
  if (rotator) rotator.kick();
});
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

// Clipboard sync: while the session is active, poll the local OS clipboard and
// forward changes to the peer over the control channel; write received peer
// clipboard text locally. lastClip tracks the last text seen/synced in either
// direction so a write we just performed doesn't get re-sent on the next poll
// (echo-loop prevention).
let clipTimer = null;
let lastClip = null;
function startClipboardSync() {
  if (clipTimer) return;
  lastClip = null;
  clipTimer = setInterval(async () => {
    try {
      const text = await window.farsightIpc.readClipboard();
      if (typeof text === 'string' && text !== '' && text !== lastClip) {
        lastClip = text;
        if (peer) peer.sendControl({ type: CONTROL.CLIPBOARD, text: text.slice(0, 100000) });
      }
    } catch { /* ignore */ }
  }, 800);
}
function stopClipboardSync() {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
}

// File transfer: bidirectional over the dedicated 'file' data channel (created
// by the controller; received here via createHostPeer's onFileMessage param).
// Active only while a peer exists — sendFile()/handleFileMessage() both no-op
// without one. State is reset on every teardown path, same as clipboard sync.
let fileTransferId = 0;
let sendingFile = false;
let pendingBufferedLowResolve = null;
let receiveState = null; // { receiver, chunks: ArrayBuffer[], id }
const sendFileBtn = document.getElementById('send-file');
const fileStatusEl = document.getElementById('file-status');

function setMenuStatus(text) { if (menuStatus) menuStatus.textContent = text; }
function setFileStatus(text) { if (fileStatusEl) fileStatusEl.textContent = text; }

// Backpressure: wait for the channel's bufferedAmount to drop below the
// threshold before sending the next chunk. cancelPendingFileSend() force-
// resolves this if a teardown happens mid-wait, so a torn-down session can
// never leave sendFile() awaiting an event that will never fire again.
async function waitForBufferedLow(peerRef) {
  if (!peerRef || peerRef.fileBufferedAmount() <= 1_000_000) return;
  await new Promise((resolve) => {
    pendingBufferedLowResolve = resolve;
    peerRef.onFileBufferedLow(() => { pendingBufferedLowResolve = null; resolve(); });
  });
}
function cancelPendingFileSend() {
  if (pendingBufferedLowResolve) { const r = pendingBufferedLowResolve; pendingBufferedLowResolve = null; r(); }
}
function resetFileReceive() { receiveState = null; }
function resetFileTransferState() {
  resetFileReceive();
  cancelPendingFileSend();
}

async function sendFile() {
  if (!peer) { setFileStatus('No active session.'); return; }
  if (sendingFile) return;
  const picked = await window.farsightIpc.pickFile();
  if (!peer) return; // session may have torn down while the OS file dialog was open
  if (!picked) return;
  if (picked.error) { setFileStatus(picked.error); return; }
  if (picked.size > MAX_FILE_SIZE) { setFileStatus('File is larger than the 100 MB transfer limit.'); return; }
  sendingFile = true;
  const id = ++fileTransferId;
  const peerRef = peer;
  try {
    peerRef.sendFileData(metaFrame({ id, name: picked.name, size: picked.size, mime: 'application/octet-stream' }));
    const bytes = picked.bytes;
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (peer !== peerRef) break; // torn down / replaced mid-send
      const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
      const chunk = bytes.slice(offset, end);
      await waitForBufferedLow(peerRef);
      if (peer !== peerRef) break;
      peerRef.sendFileData(chunk);
      offset = end;
      setFileStatus(`Sending ${picked.name}… ${Math.min(100, Math.round((offset / picked.size) * 100))}%`);
    }
    if (peer === peerRef) {
      peerRef.sendFileData(endFrame(id));
      setFileStatus(`Sent ${picked.name}.`);
    }
  } catch {
    setFileStatus('File send failed.');
  } finally {
    sendingFile = false;
  }
}
if (sendFileBtn) sendFileBtn.addEventListener('click', sendFile);

async function finishFileReceive() {
  if (!receiveState) return;
  const { receiver, chunks } = receiveState;
  receiver.end();
  resetFileReceive();
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const combined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { combined.set(new Uint8Array(c), off); off += c.byteLength; }
  const name = sanitizeFilename(receiver.name);
  try {
    const res = await window.farsightIpc.saveFile({ name, bytes: combined.buffer });
    setFileStatus(res && res.ok ? `Saved ${name}.` : 'Save cancelled.');
  } catch {
    setFileStatus('Save failed.');
  }
}

// Wired as createHostPeer's onFileMessage callback (see startSession below).
function handleFileMessage(data) {
  if (typeof data === 'string') {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.t === 'meta') {
      const receiver = createReceiver({
        onProgress: (p) => setFileStatus(`Receiving ${sanitizeFilename(frame.name)}… ${Math.round(p * 100)}%`),
      });
      try { receiver.begin(frame); } catch { setFileStatus('Incoming file rejected (too large).'); resetFileReceive(); return; }
      receiveState = { receiver, chunks: [], id: frame.id };
    } else if (frame.t === 'end') {
      if (!receiveState || receiveState.id !== frame.id) return;
      finishFileReceive();
    } else if (frame.t === 'cancel') {
      if (receiveState && receiveState.id === frame.id) { resetFileReceive(); setFileStatus('Transfer cancelled by sender.'); }
    }
    return;
  }
  // Binary chunk (ArrayBuffer). Cap total received at MAX_FILE_SIZE regardless
  // of the declared meta.size, in case a peer sends more than it announced.
  // Uses the receiver's O(1) running total (not a per-chunk reduce over
  // chunks, which is O(n^2) over a transfer) and also caps chunk COUNT, so a
  // peer sending millions of tiny chunks can't freeze the renderer or blow
  // memory via per-ArrayBuffer overhead even while staying under the byte cap.
  if (!receiveState) return;
  const buf = data instanceof ArrayBuffer ? data : (data && data.buffer);
  if (!buf) return;
  receiveState.receiver.pushChunkBytes(buf.byteLength);
  if (receiveState.receiver.received > MAX_FILE_SIZE) { resetFileReceive(); setFileStatus('Incoming file too large — aborted.'); return; }
  if (receiveState.chunks.length >= MAX_CHUNKS) { resetFileReceive(); setFileStatus('Transfer aborted (too many chunks).'); return; }
  receiveState.chunks.push(buf);
  if (receiveState.receiver.isComplete()) finishFileReceive();
}

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
  stopClipboardSync();
  resetFileTransferState();
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
    if (st === 'active') startClipboardSync();
    if (rotator) {
      if (st === 'pending_consent' || st === 'active') rotator.pause();
      else if (st === 'idle') rotator.resumeAfterSession();
    }
  },
});

async function onControl(raw) {
  let evt;
  try { evt = validateControlEvent(raw); } catch { return; }
  if (evt.type === CONTROL.CLIPBOARD) {
    lastClip = evt.text;
    window.farsightIpc.writeClipboard(evt.text);
    return;
  }
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
    onFileMessage: (data) => handleFileMessage(data),
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

// If the main process couldn't register the panic hotkey (another app owns
// Ctrl+Alt+F12), show a visible warning that the instant-kill override is
// inactive. Registered synchronously here, before this module's first
// top-level await, so it is guaranteed to be listening before the main
// process's did-finish-load handler sends 'panic-unavailable'.
window.farsightIpc.onPanicUnavailable(() => {
  document.getElementById('panic-warning').hidden = false;
});

// The session password is generated in the main process (node:crypto) and shown
// here; it is sent on REGISTER so the signaling server can gate controllers.
const sessionPassword = await window.farsightIpc.getSessionPassword();
document.getElementById('host-pw').textContent = sessionPassword;

function startSignaling(signalingUrl) {
  signal = createSignalingClient(signalingUrl, {
    [MSG.REGISTERED]: (m) => { idEl.textContent = formatHostId(m.id); idEl.dataset.copyValue = m.id; window.farsightIpc.setHostId(m.id); statusEl.textContent = 'Ready. Waiting for a controller.'; },
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

// Paint the subtle build-version label in the bottom-left corner.
window.farsightIpc.getAppVersion().then((v) => {
  const el = document.getElementById('version-tag');
  if (el && v) el.textContent = `v${v}`;
});

const signalingUrl = await window.farsightIpc.getSignalingUrl();
if (!signalingUrl) {
  appEl.style.display = 'none';      // first run: hide the normal host view...
  setupEl.hidden = false;            // ...and show setup; do not register
} else {
  appEl.style.display = 'block';
  setupEl.hidden = true;
  startSignaling(signalingUrl);
  rotator = createIdleRotator({ intervalMs: PW_ROTATE_MS, onRotate: rotatePassword });
  rotator.start();
}
