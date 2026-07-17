// packages/controller/src/renderer/renderer.js
import { isValidHostId } from '@farsight/shared/host-id';
import { normalizeHostId, passwordCandidates, formatHostId } from '@farsight/shared/credentials-format';
import { isOlder } from '@farsight/shared/version';
import { createRateEstimator, etaSeconds, bytesDone, filesDone, formatBytes, formatRate, formatDuration } from '@farsight/shared/transfer-rate';
import { railItems, activeTransferCount, TERMINAL_TRANSFER_STATES, isShellPage, SHELL_PAGES } from '@farsight/shared/shell-nav';
import { buildStatusSegments } from '@farsight/shared/status-bar';
import { transferLabel } from '@farsight/shared/transfer-label';
import { MSG } from '@farsight/shared/protocol';
import { CONTROL, validateControlEvent } from '@farsight/shared/control-events';
import { runConnectionAuth } from '@farsight/shared/connection-auth';
import { createIdleRotator } from '@farsight/shared/idle-rotator';
// Task 4's auto-registering host signaling client (REGISTER + reconnect +
// acceptsLinked) — a DIFFERENT file from the sibling one-shot ./signaling-client.js
// that the session window uses. Aliased to avoid any confusion between the two.
import { createSignalingClient as createHostSignalingClient } from '../host-signaling-client.js';
// Task 7: the inbound-control path (this machine BEING controlled). Ported
// from host/src/{peer,session,timeouts,capture}.js, one level up from this
// renderer directory — same layout as host-signaling-client.js above.
import { createHostPeer } from '../host-peer.js';
import { createSession } from '../session.js';
import { createSessionTimers } from '../timeouts.js';
import { monitorsForControl } from '../capture.js';
import { createRendererLogger } from './rlog.js';

const idInput = document.getElementById('host-id');
const statusEl = document.getElementById('status');
const setupEl = document.getElementById('setup');
const urlInput = document.getElementById('signaling-url');
const setupError = document.getElementById('setup-error');
let signalingUrl = null;
const lastCreds = { targetId: '', password: '' };

const menuStatus = document.getElementById('menu-status');

// ─── Host registration (this machine as a controllable host) ────────────────
// Unification step 3: the shell now also registers this machine as a host on
// the signaling server, mirroring host/src/renderer/renderer.js's
// startSignaling() (~:338-393) — registration + credential display only. The
// consent/capture/answering-peer machinery (host/renderer.js's MSG.CONNECT/
// OFFER/CANDIDATE handlers) is Task 7, not this task.
//
// Gated by the "Allow this computer to be controlled" setting (Task 5):
// registration happens ONLY when control is allowed AND a signaling URL is
// configured. When control is OFF, no registering client is ever created —
// fail closed, this machine is simply absent from the signaling server and
// unreachable for control (it stays reachable for file transfers, a separate
// client). Toggling live: OFF tears the registering client down; ON registers.
const hlog = createRendererLogger('host-reg');
const credIdEl = document.getElementById('cred-id');
const credPwEl = document.getElementById('cred-pw');
const hostCredentialsEl = document.getElementById('host-credentials');
const controlToggleEl = document.getElementById('control-allowed-toggle');

const HOST_PW_ROTATE_MS = 60 * 60 * 1000; // rotate the session password hourly while idle
let hostSignal = null;
let hostRotator = null;
let hostIceServers = []; // stored for Task 7's answering peer; unused by this task
let controlAllowed = true;

function setCredEl(el, value) {
  if (!el) return;
  el.textContent = value;
  el.dataset.copyValue = value;
}

// Regenerate in main (trusted, node:crypto), display it, and re-sync it to the
// signaling server if currently registered. Used by the manual ↻ button and the
// hourly idle rotator.
async function rotateHostPassword() {
  const next = await window.farsightIpc.regenerateSessionPassword();
  setCredEl(credPwEl, next);
  if (hostSignal) hostSignal.send(MSG.UPDATE_PASSWORD, { password: next });
}

async function startHostRegistration() {
  if (hostSignal || !signalingUrl) return; // already registered, or nothing to register with
  try {
    const [password, version] = await Promise.all([
      window.farsightIpc.getSessionPassword(),
      window.farsightIpc.getAppVersion(),
    ]);
    setCredEl(credPwEl, password);
    hostSignal = createHostSignalingClient(signalingUrl, {
      [MSG.REGISTERED]: (m) => {
        // Display formatted, but copy the raw id (mirrors host/renderer.js:340).
        setCredEl(credIdEl, formatHostId(m.id));
        if (credIdEl) credIdEl.dataset.copyValue = m.id;
        window.farsightIpc.setHostId(m.id);
        // Re-sync the currently-displayed password (it may have rotated
        // between REGISTER and REGISTERED, or across a reconnect).
        hostSignal.send(MSG.UPDATE_PASSWORD, { password: credPwEl ? credPwEl.textContent : password });
        hlog.info('registered id=' + m.id);
      },
      // R-1: ICE servers arrive from the server, ready for Task 7's answering peer.
      [MSG.ICE_SERVERS]: (m) => { hostIceServers = m.iceServers || []; },
      // Task 7: the controller sends CONNECT, then immediately its OFFER (and ICE
      // candidates) — but nothing is captured or streamed until the user grants
      // (or the linked path auto-grants) consent. See the "Inbound remote
      // control" section below for session/consent/capture/peer/auth-gate.
      [MSG.CONNECT]: (m) => {
        // A new incoming connect attempt: stamp a fresh correlation id so every
        // log line from this point (peer/session/auth/capture) can be grepped
        // together for this one attempt.
        connId = newConnId();
        clog = hlog.child(`conn:${connId}`);
        clog.info('connect start');
        linkedConnect = !!(m && m.linked);
        peerAuthed = false;
        window.farsightIpc.requestAttention();
        if (linkedConnect) {
          // Own fleet (account-linked): the account login on THIS machine is the
          // standing consent (§4.3) — no per-session prompt for your own devices.
          // Auto-accept; the E2E keypair handshake still gates input, so a peer
          // that isn't verifiably your device can never drive the machine.
          hostStatusEl.textContent = m && typeof m.peerVersion === 'string' ? `Linked device (v${m.peerVersion}) connecting…` : 'A linked device is connecting…';
          clog.info('consent auto-accepted (linked)');
          session.requestConsent();
          session.allow(); // synchronous idle→pending_consent→active: no visible prompt
          startSession();
        } else {
          // Ad-hoc / password connect: still requires explicit per-session consent.
          session.requestConsent();
          clog.info('consent shown');
          hostStatusEl.textContent = m && typeof m.peerVersion === 'string' ? `A controller (v${m.peerVersion}) wants to connect.` : 'A controller wants to connect.';
        }
      },
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
        hostStatusEl.textContent = 'Peer disconnected.';
      },
      // SP3 receive path (v2): a peer wants to push files at this machine. The
      // server relays TRANSFER_REQUEST on this same registration socket; forward
      // it to main, which attaches a transfer worker and round-trips consent
      // before anything touches disk. (An own-fleet push auto-accepts in main.)
      [MSG.TRANSFER_REQUEST]: (m) => {
        window.farsightIpc.transferIncoming({ sessionId: m.sessionId, linked: !!m.linked });
      },
    }, { password, version, acceptsLinked: true, log: hlog.child('signaling') });
    hostRotator = createIdleRotator({ intervalMs: HOST_PW_ROTATE_MS, onRotate: rotateHostPassword });
    hostRotator.start();
  } catch (err) {
    hlog.warn(`host registration failed to start: ${err && err.message}`);
  }
}

function stopHostRegistration() {
  // The WebRTC peer + input datachannel are P2P (TURN-relayed) and survive
  // loss of signaling — closing hostSignal alone would leave an ACTIVE
  // session's input injection running after the user flips "Allow this
  // computer to be controlled" off. End the session FIRST (sends
  // CONTROL.HOST_ENDED over the control channel so the controller sees a
  // clean end, not a dead connection) THEN stop registration. Covers both
  // callers: the live toggle change handler and refreshHostRegistration's
  // launch-time convergence.
  if (session.isActive()) endSessionByHost('control_disabled', 'Control disabled — session ended.');
  if (hostSignal) { hostSignal.close(); hostSignal = null; }
  if (hostRotator) { hostRotator.stop(); hostRotator = null; }
  hostIceServers = [];
  setCredEl(credIdEl, '…');
  setCredEl(credPwEl, '…');
}

function renderControlUi() {
  if (controlToggleEl) controlToggleEl.checked = controlAllowed;
  if (hostCredentialsEl) hostCredentialsEl.hidden = !controlAllowed;
}

// Positive-proof marker sync (test/host-capability.probe.mjs): the marker
// object literal at the bottom of this file is set once, synchronously, on
// module load — but controlAllowed and hostRegistering only become known
// asynchronously (getControlAllowed() is an IPC round-trip, and registration
// itself is gated on it). Rather than block the marker assignment, the async
// registration path writes these two fields onto the already-published marker
// every time either changes; the probe polls for them. Guarded by a presence
// check because early calls (e.g. a stray stopHostRegistration before launch
// eager-init runs) could in principle race the marker's own assignment —
// in practice they can't (see the comment at the marker itself), but the
// guard costs nothing and keeps this function safe to call from anywhere.
function syncHostMarker() {
  if (!window.__farsightShellReady) return;
  window.__farsightShellReady.controlAllowed = controlAllowed;
  window.__farsightShellReady.hostRegistering = !!hostSignal;
}

// Re-read the persisted setting and converge registration state to it. Called
// on launch (once signalingUrl is known) and whenever signaling reconfigures.
async function refreshHostRegistration() {
  controlAllowed = await window.farsightIpc.getControlAllowed();
  renderControlUi();
  if (controlAllowed) await startHostRegistration();
  else stopHostRegistration();
  syncHostMarker();
}

if (controlToggleEl) {
  controlToggleEl.addEventListener('change', async () => {
    controlAllowed = controlToggleEl.checked;
    await window.farsightIpc.setControlAllowed(controlAllowed);
    renderControlUi();
    if (controlAllowed) await startHostRegistration();
    else stopHostRegistration();
    syncHostMarker();
  });
}
document.getElementById('cred-regen')?.addEventListener('click', async () => {
  await rotateHostPassword();
  if (hostRotator) hostRotator.kick();
});

// ─── Inbound remote control (Task 7) ────────────────────────────────────────
// Unification step 3: when a controller connects to THIS machine (registered
// above), port the host's consent/capture/answering-peer/auth-gate machinery
// in here — VERBATIM from host/src/renderer/renderer.js, adapted only at the
// seams: `signal` -> `hostSignal` and `iceServers` -> `hostIceServers` (Task
// 6's registration client/state, reused rather than duplicated), `rotator` ->
// `hostRotator` (ditto), and `statusEl` -> `hostStatusEl` (this file's #status
// is the unrelated connect-to-a-host status line on the home page). There is
// no video/session window on this side — hosting is a consent-modal +
// status-line experience; the MSG.CONNECT/OFFER/CANDIDATE/PEER_DISCONNECTED
// handlers live on hostSignal's own handler map (see startHostRegistration
// above), so this whole path is only reachable while hostSignal exists — i.e.
// only while "Allow this computer to be controlled" is on (Task 6).
const hostStatusEl = document.getElementById('host-status');
const consentEl = document.getElementById('consent');

// A fresh base64 nonce for the connect-from-console handshake (Web Crypto in the
// renderer). 16 bytes → ample against replay within a single handshake.
function authNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

// newConnId()/clog mirror host/renderer.js: a fresh, greppable log scope per
// connect attempt, reassigned at the start of each MSG.CONNECT (see above).
const newConnId = (() => { let n = 0; return () => (++n).toString(36) + Math.random().toString(36).slice(2, 6); })();
let connId = newConnId();
let clog = hlog.child(`conn:${connId}`);

let peer = null;
let displays = [];
let currentStream = null;
let timers = null;

async function getStreamForDisplay(display) {
  // desktopCapturer runs in main; renderer asks for the source id for the given
  // monitor, then uses getUserMedia to capture it.
  const sourceId = await window.farsightIpc.getScreenSourceFor(display.id);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 30,
    } },
  });
  // Breadcrumb only — resolution/monitor index, NEVER pixel/frame data.
  const track = stream.getVideoTracks()[0];
  const s = track && track.getSettings ? track.getSettings() : {};
  clog.child('capture').info(`capture stream monitor=${display.index} ${s.width || '?'}x${s.height || '?'}`);
  return stream;
}

// The controller sends CONNECT then immediately its OFFER (and ICE candidates),
// but the host does not build its peer until the user grants consent — which
// can take several seconds. Buffer the early offer/candidates and apply them
// once the peer exists and the remote description is set; otherwise they would
// be silently dropped and the session would hang with no video.
let remoteReady = false;
let pendingOffer = null;
const pendingCandidates = [];

// Connect-from-console (SP2 §4.4): when the server flags a CONNECT as `linked`
// (password-free, from one of the owner's own account devices), the controller is
// authenticated end-to-end over the 'auth' data channel with device keypairs.
// Until that handshake passes, input injection is BLOCKED (peerAuthed gates it),
// so a linked peer can never drive the machine without proving it's the owner's
// device. The classic id+password path leaves linkedConnect false and is untouched.
let linkedConnect = false;
let peerAuthed = false;

async function runHostAuth(channel) {
  // Attach a synchronous buffer the instant the channel arrives, so the
  // controller's first message (hello) can't be dropped during the async identity
  // fetch below — the data channel won't replay a message sent before onmessage
  // was set. Buffered messages are replayed into the pump once it's wired.
  const early = [];
  channel.onmessage = (e) => early.push(e);
  let deviceId = null, publicKey = null;
  try {
    [deviceId, publicKey] = await Promise.all([
      window.farsightIpc.connAuthDeviceId(),
      window.farsightIpc.connAuthPublicKey(),
    ]);
  } catch { /* leave null → handshake fails closed */ }
  const fp = peer.getFingerprints();
  console.debug('[connect-auth host] fp', fp, 'deviceId', deviceId, 'hasKey', !!publicKey);
  try {
    const p = runConnectionAuth({
      role: 'host', channel, deviceId, publicKey,
      localFingerprint: fp.local, remoteFingerprint: fp.remote,
      sign: (m) => window.farsightIpc.connAuthSign(m),
      verify: (pk, m, s) => window.farsightIpc.connAuthVerify(pk, m, s),
      isAccountKey: (pk) => window.farsightIpc.connAuthIsAccountKey(pk),
      nonce: authNonce, timeoutMs: 20000,
      log: clog.child('auth'),
    });
    for (const e of early) channel.onmessage(e); // replay into the pump's handler
    await p;
    peerAuthed = true; // control unlocked
    hostStatusEl.textContent = 'Linked device verified — session active.';
  } catch (e) {
    // Failed device verification (unknown key / bad signature / fingerprint
    // mismatch / timeout) → block and end. Nothing was ever injectable. Surface
    // the reason so failures are diagnosable.
    const reason = (e && e.message) ? e.message : 'error';
    console.error('[connect-auth host] failed:', reason);
    endSessionByHost('auth_failed', `Connection blocked — device verification failed (${reason}).`);
  }
}

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

function flushCandidates() {
  while (pendingCandidates.length) peer.handleCandidate(pendingCandidates.shift());
}

// Full teardown: stop screen capture (releases the OS capture indicator), close
// the peer, and clear buffered signaling. Used by the auth-failure path, peer-
// disconnect, controller-initiated SESSION_END, and session timeouts.
function teardown() {
  clog.info('session teardown');
  if (currentStream) { currentStream.getTracks().forEach((t) => t.stop()); currentStream = null; }
  if (peer) { peer.close(); peer = null; }
  if (timers) { timers.stop(); timers = null; }
  stopClipboardSync();
  remoteReady = false;
  pendingOffer = null;
  pendingCandidates.length = 0;
  linkedConnect = false;
  peerAuthed = false;
}

// End an active session that the HOST initiated (auth failure, timeout, panic).
// Notify the controller over the reliable control channel first so it shows a
// clear "session ended" message instead of trying to reconnect, then tear down.
// A short flush delay lets the ordered channel deliver the message before the
// peer closes; panic tears down immediately (physical override wins).
function endSessionByHost(reason, statusText, { immediate = false } = {}) {
  if (peer) { try { peer.sendControl({ type: CONTROL.HOST_ENDED, reason }); } catch { /* channel gone */ } }
  session.end();
  hostStatusEl.textContent = statusText;
  if (immediate || !peer) teardown();
  else setTimeout(teardown, 150);
}

// Consent gate: nothing is captured or streamed until the user clicks Allow (or
// the linked path auto-allows below). Unlike host's own window, the shell has no
// #idle/#banner views or in-session body class to toggle — hosting has no video
// on this side, so the only visible state is the consent modal + the status line.
const hostedSessionBarEl = document.getElementById('hosted-session-bar');
const session = createSession({
  log: clog.child('session'),
  onStateChange: (st) => {
    window.farsightIpc.setSessionActive(st === 'active');
    consentEl.hidden = st !== 'pending_consent';
    // Security-posture fix: a reliable manual Disconnect for an active hosted
    // session (panic may be unavailable; this task also dropped #cut). Shown
    // IFF a session is actively controlling this machine.
    if (hostedSessionBarEl) hostedSessionBarEl.hidden = st !== 'active';
    if (st === 'active') startClipboardSync();
    if (hostRotator) {
      if (st === 'pending_consent' || st === 'active') hostRotator.pause();
      else if (st === 'idle') hostRotator.resumeAfterSession();
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
    peer && peer.sendControl({ type: CONTROL.MONITORS, monitors: monitorsForControl(displays, clog.child('capture')) });
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
    hostStatusEl.textContent = 'Session ended by controller.';
  }
}

async function startSession() {
  displays = await window.farsightIpc.listDisplays();
  const primary = displays.find((d) => d.primary) ?? displays[0];
  currentStream = await getStreamForDisplay(primary);
  await window.farsightIpc.selectInjectorDisplay(primary.index);
  peer = createHostPeer({
    stream: currentStream,
    iceServers: hostIceServers,
    sendSignal: (type, payload) => hostSignal.send(type, payload),
    // Input injection runs in the main process. Only forward while the session
    // is active — a second layer over the consent gate. Each event counts as
    // activity so an actively-used session doesn't hit the idle timeout.
    // Input is gated on the session being active AND — for a linked connect —
    // the device-keypair handshake having passed. A linked peer cannot inject
    // until peerAuthed flips true.
    onInput: (evt) => { if (session.isActive() && (!linkedConnect || peerAuthed)) { window.farsightIpc.injectInput(evt); if (timers) timers.activity(); } },
    onControl: (evt) => onControl(evt),
    // Only authenticate on the linked path; on the password path the auth channel
    // is unused (the controller never starts a handshake) and is ignored.
    onAuthChannel: (channel) => { if (linkedConnect) runHostAuth(channel); },
    log: clog.child('peer'),
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
  hostStatusEl.textContent = 'Session active.';
  await startSession();
});
document.getElementById('deny').addEventListener('click', () => {
  session.deny();
  teardown();
  hostStatusEl.textContent = 'Request denied. Waiting for a controller.';
});
document.getElementById('hosted-session-disconnect')?.addEventListener('click', () => {
  endSessionByHost('disconnect', 'Session ended.');
});

// Panic hotkey (Ctrl/Cmd+Alt+F12) fires from the main process — instantly kill
// any session. The physical override always wins.
window.farsightIpc.onPanic(() => {
  endSessionByHost('panic', 'Session ended by panic key.', { immediate: true });
});

// If the main process couldn't register the panic hotkey (another app owns
// Ctrl+Alt+F12), show a visible warning that the instant-kill override is
// inactive.
window.farsightIpc.onPanicUnavailable(() => {
  document.getElementById('panic-warning').hidden = false;
});

// Copy buttons on the ID/password chips (clipboard is allowed in the renderer).
for (const btn of document.querySelectorAll('.cbtn[data-copy]')) {
  btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    const text = el.dataset.copyValue || el.textContent;
    try { await navigator.clipboard.writeText(text); const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1200); } catch { /* ignore */ }
  });
}

// ─── Status bar ──────────────────────────────────────────────────────────────
// The always-on overview. Replaces #update-banner and #version-tag, which both
// pinned to bottom:0 and would collide with this strip.
const statusbarEl = document.getElementById('statusbar');
const statusState = {
  signaling: 'connecting',
  signedInAs: null,
  session: null,     // { peer, rttMs, width, height, transport }
  update: null,      // { version }
  appVersion: null,
};

const SB_FOCUS = {
  transfers: () => showPage('transfers'),
  session: () => window.farsightIpc.focusSession(),
  'install-update': () => window.farsightIpc.installUpdate(),
};

// Paint one segment's content (dot / progress bar / label + clickability) into an
// existing element without touching the surrounding DOM structure.
function paintSeg(el, s, onClick) {
  el.className = `sb-seg${onClick ? ' clickable' : ''}${s.kind === 'version' ? ' sb-ver' : ''}`;
  el.replaceChildren();
  if (s.dot) el.appendChild(Object.assign(document.createElement('span'), { className: `sb-dot ${s.dot}` }));
  if (s.bar !== null) {
    const bar = document.createElement('span');
    bar.className = 'sb-bar';
    const fill = document.createElement('span');
    fill.className = 'sb-bar-fill';
    fill.style.width = `${Math.round(s.bar * 100)}%`; // CSSOM write — not subject to style-src
    bar.appendChild(fill);
    el.appendChild(bar);
  }
  el.appendChild(Object.assign(document.createElement('span'), { textContent: s.text }));
}

// segment id -> its live element, valid only while the segment IDENTITY LIST
// (statusbarIds) is unchanged from the previous render. onTransferEvent fires
// renderStatusBar() per-file and UNTHROTTLED — same as renderRail() below, whose
// comment documents the demonstrated bug: a keyboard user can be focused on a
// clickable segment (Transfers, Restart to update) when a progress tick lands, and
// a plain rebuild-every-time (replaceChildren()) would blur it. A progress tick
// never changes WHICH segments exist or their order, only their text/bar — so the
// hot path mutates existing nodes in place and never removes any of them, and
// focus survives. Only a genuine structural change (session start/end, sign-in/
// out, a transfer entering/leaving the bar, update becoming ready) rebuilds the
// strip from scratch; that residual case can still move focus, same as the rail's
// own fix left unresolved for its rarer structural rebuilds.
let statusbarIds = [];
const statusbarSegs = new Map();

function renderStatusBar() {
  const segments = buildStatusSegments({
    ...statusState,
    transfers: [...transferJobs.values()].map((j) => ({
      jobId: j.jobId,
      peer: transferLabel(j), // the file/folder name, not an often-unknown peer id
      direction: j.direction,
      progress: j.progress,
      rate: j.rate,
      state: j.state,
    })),
  });

  const ids = segments.map((s) => s.id);
  const structureChanged = ids.length !== statusbarIds.length || ids.some((id, i) => id !== statusbarIds[i]);

  if (!structureChanged) {
    segments.forEach((s) => paintSeg(statusbarSegs.get(s.id), s, s.focus ? SB_FOCUS[s.focus] : null));
    return;
  }

  statusbarSegs.clear();
  statusbarEl.replaceChildren();
  statusbarIds = ids;
  segments.forEach((s, i) => {
    if (i > 0) statusbarEl.appendChild(Object.assign(document.createElement('span'), { className: 'sb-div' }));
    if (s.kind === 'version') statusbarEl.appendChild(Object.assign(document.createElement('span'), { className: 'sb-spring' }));
    const onClick = s.focus ? SB_FOCUS[s.focus] : null;
    const el = document.createElement(onClick ? 'button' : 'span');
    if (onClick) el.onclick = onClick;
    paintSeg(el, s, onClick);
    statusbarEl.appendChild(el);
    statusbarSegs.set(s.id, el);
  });
}

window.farsightIpc.onUpdateStatus((ui) => {
  statusState.update = ui.showRestartPrompt ? { version: ui.version } : null;
  menuStatus.textContent = ui.message || '';
  renderStatusBar();
});

// Unification step 2: the remote-control session runs in its own BrowserWindow
// (session-window.js). It pushes its live status here; the shell owns no
// session code, only the reflection.
window.farsightIpc.onSessionStatus((s) => {
  statusState.session = s; // {peer,rttMs,width,height,transport} or null
  renderStatusBar();
});
window.farsightIpc.onSessionClosed(() => {
  statusState.session = null;
  renderStatusBar();
});

document.getElementById('menu-check-updates').addEventListener('click', () => window.farsightIpc.checkForUpdates());
document.getElementById('menu-open-logs').addEventListener('click', () => { window.farsightIpc.openLogs(); });

// Verbose diagnostic logging: only shown once signed in (see refreshAccountView
// and the resume-session call near the bottom of this file, which both keep
// this in sync with the real signed-in state).
const menuSendDiagnostics = document.getElementById('menu-send-diagnostics');
menuSendDiagnostics.addEventListener('click', async () => {
  const res = await window.farsightIpc.sendDiagnostics();
  if (res.ok) menuStatus.textContent = `Diagnostics sent (id ${res.id}).`;
  else if (res.error !== 'cancelled') menuStatus.textContent = `Diagnostics upload failed: ${res.error}`;
});

async function refreshSignalingUrl() {
  signalingUrl = await window.farsightIpc.getSignalingUrl();
  const configured = Boolean(signalingUrl);
  setupEl.hidden = configured;
  shellEl.hidden = !configured;
  statusState.signaling = configured ? 'ready' : 'connecting';
  renderStatusBar();
  if (configured) { showPage(activePage); refreshHostRegistration(); }
  else stopHostRegistration();
}
async function saveSignaling() {
  const res = await window.farsightIpc.setSignalingUrl(urlInput.value);
  if (res.ok) { setupError.textContent = ''; await refreshSignalingUrl(); }
  else { setupError.textContent = res.error; }
}
document.getElementById('save-signaling').addEventListener('click', saveSignaling);
document.getElementById('menu-change-server').addEventListener('click', async () => {
  urlInput.value = (await window.farsightIpc.getSignalingUrl()) || '';
  setupError.textContent = '';
  shellEl.hidden = true;
  setupEl.hidden = false;
});

// Cache our own version for the SP1 version-aware handshake (sent on CONNECT and
// compared against the host's relayed version), and feed it to the status bar
// (replaces the old bottom-left #version-tag label).
let appVersion = null;
window.farsightIpc.getAppVersion().then((v) => {
  appVersion = v || null;
  statusState.appVersion = appVersion;
  renderStatusBar();
});

// The remote-control session (video, input capture, peer connection, signaling,
// clipboard sync, stats, in-session overlay, connect-from-console auth) lives in
// its own BrowserWindow — packages/controller/src/session-window/session.js.
// This form only validates input and asks main to open that window; the shell
// owns none of the connection logic (unification step 2).
document.getElementById('go').addEventListener('click', () => {
  if (!signalingUrl) return;
  const targetId = normalizeHostId(idInput.value);
  const typedPassword = document.getElementById('host-pw').value;
  // SP1 compat shim: try the normalized password first, then the raw typed
  // value (pre-v1.4 hosts registered the dashed literal). We advance through
  // these only on a bad_password reply, so a current host never triggers a retry.
  const candidates = passwordCandidates(typedPassword);
  lastCreds.targetId = targetId;
  lastCreds.password = typedPassword;
  if (!isValidHostId(targetId)) { statusEl.textContent = 'Invalid ID.'; return; }
  if (candidates.length === 0) { statusEl.textContent = 'Enter the host password.'; return; }
  window.farsightIpc.openSession({ targetId, candidates, linked: false });
});

// ── Saved-hosts console (SP2) ────────────────────────────────────────────────
// A panel over the connect screen: sign in to the account service, then see the
// fleet — each saved host's presence and version, with an "update available"
// note when it lags this build (the SP1 host-version note, promoted). All
// account work happens in main (window.farsightIpc.account*); the renderer only
// renders and never touches the password beyond passing it through.
const acctSignin = document.getElementById('acct-signin');
const acctFleet = document.getElementById('acct-fleet');
const acctEmail = document.getElementById('acct-email');
const acctPassword = document.getElementById('acct-password');
const acctCode = document.getElementById('acct-code');
const acctSigninBtn = document.getElementById('acct-signin-btn');
const acctSigninError = document.getElementById('acct-signin-error');
const fleetList = document.getElementById('fleet-list');
const fleetSub = document.getElementById('fleet-sub');
const fleetError = document.getElementById('fleet-error');

const setMsg = (el, text, ok = false) => { el.textContent = text; el.style.color = ok ? 'var(--ok)' : 'var(--danger-ink)'; };

// account:status carries no email (see account-service.status(), which returns
// only { signedIn }) — the only identity this renderer ever learns is whatever
// the user just typed to sign in, captured here. A session resumed from a
// persisted token at launch (nobody re-typed anything this run) is signed in but
// this stays null, so the bar's account segment is simply omitted rather than
// showing a wrong or made-up name — buildStatusSegments() already treats a null
// signedInAs as "no account segment", not an error state.
let signedInEmail = null;

async function refreshAccountView() {
  const { signedIn } = await window.farsightIpc.accountStatus();
  acctSignin.hidden = signedIn;
  acctFleet.hidden = !signedIn;
  menuSendDiagnostics.hidden = !signedIn;
  statusState.signedInAs = signedIn ? signedInEmail : null;
  renderStatusBar();
  if (signedIn) loadFleet();
}

const SIGNIN_ERRORS = {
  bad_credentials: 'Wrong email or password.',
  email_unverified: 'Verify your email first — check your inbox.',
  totp_required: 'Enter your two-factor code.',
  totp_invalid: 'That code didn’t work — try again.',
  network_error: 'Can’t reach the account server.',
};
async function doSignIn() {
  setMsg(acctSigninError, '');
  const email = acctEmail.value.trim();
  const password = acctPassword.value;
  const code = acctCode.value.replace(/\s+/g, '') || undefined;
  if (!email || !password) { setMsg(acctSigninError, 'Enter your email and password.'); return; }
  acctSigninBtn.disabled = true;
  acctSigninBtn.textContent = 'Signing in…';
  let res;
  try {
    // deviceName is set authoritatively in main from os.hostname() — don't send a
    // hardcoded label here (that made every fleet device show as "Controller").
    res = await window.farsightIpc.accountLogin({ email, password, code });
  } catch {
    res = { ok: false, error: 'network_error' };
  } finally {
    acctSigninBtn.disabled = false;
    acctSigninBtn.textContent = 'Sign in';
  }
  if (res.ok) {
    signedInEmail = email;
    acctPassword.value = '';
    acctCode.value = '';
    refreshAccountView();
  } else if (res.error === 'email_unverified') {
    // Auto-resend a fresh verification link so an expired one can't lock the user out.
    await window.farsightIpc.accountResendVerification({ email });
    setMsg(acctSigninError, `Your email isn’t verified yet — we’ve sent a fresh link to ${email}. Click it, then sign in.`, true);
  } else {
    setMsg(acctSigninError, SIGNIN_ERRORS[res.error] || 'Sign-in failed. Try again.');
  }
}

const REGISTER_ERRORS = {
  email_taken: 'That email already has an account — sign in instead.',
  weak_password: 'Choose a stronger password (at least 8 characters).',
  network_error: 'Can’t reach the account server.',
};
async function doRegister() {
  const email = acctEmail.value.trim();
  const password = acctPassword.value;
  if (!email || !password) { setMsg(acctSigninError, 'Enter an email and password to create your account.'); return; }
  const res = await window.farsightIpc.accountRegister({ email, password });
  if (res.ok) setMsg(acctSigninError, 'Account created — check your email to verify, then sign in.', true);
  else setMsg(acctSigninError, REGISTER_ERRORS[res.error] || 'Couldn’t create the account.');
}
async function doForgot() {
  const email = acctEmail.value.trim();
  if (!email) { setMsg(acctSigninError, 'Enter your email first, then choose Forgot password.'); return; }
  await window.farsightIpc.accountRequestPasswordReset({ email });
  setMsg(acctSigninError, 'If that email has an account, a reset link is on its way.', true);
}

async function loadFleet() {
  setMsg(fleetError, '');
  // Fetch the fleet and THIS device's id together so we can drop our own row —
  // the fleet console is for reaching your OTHER machines; showing the machine
  // you're sitting at is just noise (and you can't connect to yourself).
  const [res, myDeviceId] = await Promise.all([
    window.farsightIpc.accountFleet(),
    window.farsightIpc.connAuthDeviceId(),
  ]);
  if (!res.ok) {
    if (res.error === 'not_signed_in') { refreshAccountView(); return; }
    setMsg(fleetError, 'Couldn’t load your fleet. Check your connection.');
    return;
  }
  const devices = (res.data.devices || []).filter((d) => !myDeviceId || d.id !== myDeviceId);
  renderFleet(devices);
}
function renderFleet(devices) {
  const online = devices.filter((d) => d.online).length;
  fleetSub.textContent = devices.length ? `${devices.length} device${devices.length > 1 ? 's' : ''} · ${online} online` : '';
  fleetList.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'fleet-empty';
    empty.textContent = 'No devices yet. Install Farsight on a machine and sign in there to add it to your fleet.';
    fleetList.appendChild(empty);
    return;
  }
  for (const d of devices) fleetList.appendChild(hostRow(d));
}
function hostRow(d) {
  const row = document.createElement('div');
  row.className = 'host-row' + (d.online ? ' online' : '');

  const dot = document.createElement('div');
  dot.className = 'host-dot';

  const main = document.createElement('div');
  main.className = 'host-main';
  const name = document.createElement('div');
  name.className = 'host-name';
  name.textContent = d.name || 'Unnamed device';
  const meta = document.createElement('div');
  meta.className = 'host-meta';
  meta.textContent = [d.appVersion ? `v${d.appVersion}` : 'version unknown', lastSeenText(d)].filter(Boolean).join(' · ');
  main.append(name, meta);

  const right = document.createElement('div');
  right.className = 'host-right';
  // Remote update (S2.7): a host behind this controller's version gets an actionable
  // Update button. Setting the directive makes the host converge to the official feed
  // on its next heartbeat (works even if it's offline now — it converges on return).
  if (d.appVersion && appVersion && isOlder(d.appVersion, appVersion)) {
    // "Updating…" while a newer target than the host's current version is pending.
    const pending = d.targetVersion && isOlder(d.appVersion, d.targetVersion);
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost host-update';
    if (pending) {
      btn.textContent = 'Updating…';
      btn.disabled = true;
    } else {
      btn.textContent = 'Update';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Updating…';
        const res = await window.farsightIpc.accountRequestUpdate({ deviceId: d.id, targetVersion: appVersion });
        if (!res || !res.ok) {
          btn.disabled = false;
          btn.textContent = 'Update';
          setMsg(fleetError, 'Couldn’t request the update. Check your connection.');
        } else {
          // A download+install+relaunch takes ~10-60s. Re-poll for a bounded
          // window so the row reflects the host coming back on the new
          // version, instead of sitting on "Updating…" until a manual refresh.
          let polls = 0;
          const t = setInterval(() => {
            // The fleet page may have been navigated away from (or a connect
            // started, which also leaves it) while this poll was running — bail
            // out instead of making IPC calls + DOM writes into a page nobody
            // can see.
            if (activePage !== 'fleet') { clearInterval(t); return; }
            polls += 1; loadFleet(); if (polls >= 12) clearInterval(t);
          }, 5000);
        }
      };
    }
    right.appendChild(btn);
  }
  // Online/offline needs no words — the coloured .host-dot already shows it.

  // Connect-from-console (SP2 §4.4): a password-free Connect for an online device
  // that has enrolled a key and reported where it's reachable (signalingId). The
  // handshake proves it's your own device; the host still prompts for consent.
  if (d.online && d.signalingId && d.publicKey) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary host-connect';
    btn.textContent = 'Connect';
    btn.onclick = () => { window.farsightIpc.openSession({ targetId: d.signalingId, candidates: [], linked: true }); };
    right.appendChild(btn);

    // SP3 Phase 4: password-free send to an own-fleet device. The same
    // device-keypair handshake as Connect authenticates the transfer end to end
    // (no session password), and own-fleet receives are auto-accepted on the host.
    // Two buttons because Windows/Linux can't pick files AND a folder in one OS
    // dialog (same reason the ad-hoc Send panel has two). Folder = the flagship
    // "send a game folder to your fleet" case.
    for (const [label, mode] of [['Files…', 'files'], ['Folder…', 'folder']]) {
      const b = document.createElement('button');
      b.className = 'btn btn-ghost host-send';
      b.textContent = label;
      b.onclick = () => sendToFleetDevice(d, b, mode);
      right.appendChild(b);
    }
  }

  // Remove a stale/old device from the fleet (server-side revoke — it drops out of
  // the list). Two-step to avoid accidents: the first click arms ("Remove?"), the
  // second confirms; it disarms itself after a few seconds.
  const remove = document.createElement('button');
  remove.className = 'btn btn-ghost host-remove';
  remove.textContent = 'Remove';
  let armed = false;
  let armTimer = null;
  remove.onclick = async () => {
    if (!armed) {
      armed = true;
      remove.textContent = 'Remove?';
      remove.style.color = 'var(--danger-ink)';
      armTimer = setTimeout(() => { armed = false; remove.textContent = 'Remove'; remove.style.color = ''; }, 3000);
      return;
    }
    clearTimeout(armTimer);
    remove.disabled = true;
    remove.textContent = 'Removing…';
    const res = await window.farsightIpc.accountRevokeDevice(d.id);
    if (!res || !res.ok) {
      remove.disabled = false; armed = false; remove.textContent = 'Remove'; remove.style.color = '';
      setMsg(fleetError, 'Couldn’t remove that device. Check your connection.');
    } else {
      loadFleet();
    }
  };
  right.appendChild(remove);

  row.append(dot, main, right);
  return row;
}
function lastSeenText(d) {
  if (d.online || !d.lastSeenAt) return d.online ? '' : 'never seen';
  const then = new Date(d.lastSeenAt).getTime();
  if (!then) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'seen just now';
  if (mins < 60) return `seen ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `seen ${hrs}h ago`;
  return `seen ${Math.floor(hrs / 24)}d ago`;
}

document.getElementById('acct-signout').addEventListener('click', async () => { await window.farsightIpc.accountLogout(); signedInEmail = null; refreshAccountView(); });
document.getElementById('fleet-refresh').addEventListener('click', loadFleet);
acctSigninBtn.addEventListener('click', doSignIn);
document.getElementById('acct-register').addEventListener('click', doRegister);
document.getElementById('acct-forgot').addEventListener('click', doForgot);
for (const el of [acctPassword, acctCode, acctEmail]) {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
}

// ── Contacts (friends list) ─────────────────────────────────────────────────
// A separate panel from the fleet console: contacts are OTHER people's Farsight
// accounts (added by email, subject to accept/decline), not this account's own
// devices. Sends to an accepted contact's device reuse the same password-free
// "linked" transfer path as the fleet console (sendToFleetDevice), but the
// target also carries contact:true so main/transfer-service route it through
// the contact-consent path rather than the own-fleet auto-accept path.
async function loadContacts() {
  setMsg(document.getElementById('contacts-error'), '');
  const res = await window.farsightIpc.accountContacts();
  if (!res.ok) {
    if (res.error === 'not_signed_in') { showPage('fleet'); return; }
    setMsg(document.getElementById('contacts-error'), 'Couldn’t load contacts. Check your connection.');
    return;
  }
  renderContacts(res.data || { accepted: [], incoming: [], outgoing: [] });
}

function renderContacts(view) {
  const accepted = view.accepted || [], incoming = view.incoming || [], outgoing = view.outgoing || [];
  document.getElementById('contacts-sub').textContent =
    `${accepted.length} contact${accepted.length === 1 ? '' : 's'}`;

  // Incoming requests → Accept / Decline
  const inc = document.getElementById('contacts-incoming');
  inc.replaceChildren();
  for (const r of incoming) {
    const row = document.createElement('div'); row.className = 'host-row';
    const main = document.createElement('div'); main.className = 'host-main';
    const name = document.createElement('div'); name.className = 'host-name'; name.textContent = r.email;
    const meta = document.createElement('div'); meta.className = 'host-meta'; meta.textContent = 'wants to connect';
    main.append(name, meta);
    const right = document.createElement('div'); right.className = 'host-right';
    const acc = document.createElement('button'); acc.className = 'btn btn-primary'; acc.textContent = 'Accept';
    acc.onclick = async () => { await window.farsightIpc.accountContactAccept(r.contactId); loadContacts(); };
    const dec = document.createElement('button'); dec.className = 'btn btn-ghost'; dec.textContent = 'Decline';
    dec.onclick = async () => { await window.farsightIpc.accountContactDecline(r.contactId); loadContacts(); };
    right.append(acc, dec);
    row.append(main, right);
    inc.appendChild(row);
  }

  // Accepted contacts → one row per device, Files…/Folder… when online
  const list = document.getElementById('contacts-list');
  list.replaceChildren();
  if (!accepted.length && !incoming.length && !outgoing.length) {
    const empty = document.createElement('div'); empty.className = 'fleet-empty';
    empty.textContent = 'No contacts yet. Add someone by their Farsight account email.';
    list.appendChild(empty);
  }
  for (const c of accepted) {
    const row = document.createElement('div'); row.className = 'host-row' + (c.online ? ' online' : '');
    const dot = document.createElement('div'); dot.className = `host-dot ${c.online ? 'on' : ''}`;
    const main = document.createElement('div'); main.className = 'host-main';
    const name = document.createElement('div'); name.className = 'host-name'; name.textContent = c.email;
    const meta = document.createElement('div'); meta.className = 'host-meta'; meta.textContent = c.online ? 'online' : 'offline';
    main.append(name, meta);
    const right = document.createElement('div'); right.className = 'host-right';
    if (c.online && c.signalingId) {
      for (const [label, mode] of [['Files…', 'files'], ['Folder…', 'folder']]) {
        const b = document.createElement('button'); b.className = 'btn btn-ghost host-send'; b.textContent = label;
        b.onclick = () => sendToContact(c, b, mode);
        right.appendChild(b);
      }
    }
    row.append(dot, main, right);
    list.appendChild(row);
  }

  // Outgoing pending
  const out = document.getElementById('contacts-outgoing');
  out.replaceChildren();
  for (const r of outgoing) {
    const row = document.createElement('div'); row.className = 'host-row';
    const main = document.createElement('div'); main.className = 'host-main';
    const name = document.createElement('div'); name.className = 'host-name'; name.textContent = r.email;
    const meta = document.createElement('div'); meta.className = 'host-meta'; meta.textContent = 'invite sent — waiting to accept';
    main.append(name, meta);
    row.appendChild(main);
    out.appendChild(row);
  }
}

async function sendToContact(c, btn, mode = 'files') {
  const paths = await window.farsightIpc.transferPickPaths(mode);
  if (!paths || paths.length === 0) return;
  if (btn) btn.disabled = true;
  try {
    const res = await window.farsightIpc.transferSend({
      target: { id: c.signalingId, deviceId: c.deviceId, linked: true, contact: true }, paths,
    });
    showPage('home');
    if (res && res.jobId) {
      transferJobs.set(res.jobId, {
        jobId: res.jobId, direction: 'send', target: { id: c.email || c.signalingId },
        manifest: res.manifest, state: 'awaiting-approval', createdAt: Date.now(),
      });
      showPage('transfers');
    } else {
      setMsg(document.getElementById('contacts-error'), (res && res.error) || 'Could not start the transfer.');
    }
  } catch {
    setMsg(document.getElementById('contacts-error'), 'Could not start the transfer.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById('contacts-refresh').addEventListener('click', loadContacts);
document.getElementById('contact-add-btn').addEventListener('click', async () => {
  const email = document.getElementById('contact-add-email').value.trim();
  if (!email) return;
  const res = await window.farsightIpc.accountContactAdd(email);
  if (!res.ok) {
    setMsg(document.getElementById('contacts-error'), res.error === 'no_such_user'
      ? 'No Farsight account with that email — ask them to sign up first.'
      : 'Could not add that contact.');
    return;
  }
  document.getElementById('contact-add-email').value = '';
  loadContacts();
});

// Resume a persisted account session on launch so a signed-in controller starts
// reporting presence immediately (heartbeat), without waiting for the fleet panel
// to be opened. No stored token → no network call; status() just returns signed-out.
// Also paints the diagnostics-menu item's initial visibility (it otherwise only
// refreshes when the fleet panel opens, via refreshAccountView above).
window.farsightIpc.accountStatus().then(({ signedIn }) => {
  menuSendDiagnostics.hidden = !signedIn;
  statusState.signedInAs = signedIn ? signedInEmail : null;
  renderStatusBar();
});

// ── SP3 file transfer (send path) ───────────────────────────────────────────
// A "Send…" entry point (dial a peer by ID+password, pick files/folders, send)
// and a "Transfers" panel (live progress + best-effort cancel), both reached
// from the settings menu. This uses a DEDICATED transfer-worker connection
// (main.js's getTransferService/createTransferWorker) — separate from the
// active remote-control session's peer, so a send doesn't require (or
// interfere with) an open control session. Receiving is wired too (v2): an
// incoming offer arrives via the host-registration socket (see the
// MSG.TRANSFER_REQUEST handler) and prompts through the consent modal below.
const sendHostId = document.getElementById('send-host-id');
const sendHostPw = document.getElementById('send-host-pw');
const sendFilesBtn = document.getElementById('send-files-btn');
const sendFolderBtn = document.getElementById('send-folder-btn');
const sendStatusEl = document.getElementById('send-status');
const transfersListEl = document.getElementById('transfers-list');
const transfersEmptyEl = document.getElementById('transfers-empty');

// ── SP3 file transfer (receive path, v2) ────────────────────────────────────
// The unified app is now also a transfer DESTINATION: main forwards an incoming
// offer here as a consent prompt (manifest preview) before anything touches
// disk. An own-fleet push auto-accepts in main and never reaches this modal.
const consentModalEl = document.getElementById('transfer-consent');
const consentSummaryEl = document.getElementById('transfer-consent-summary');
const consentDestEl = document.getElementById('transfer-consent-dest');
const consentTreeEl = document.getElementById('transfer-consent-tree');

// Build a nested folder/file tree from the manifest's flat, '/'-separated paths
// (transfer-manifest sanitizes them to posix-relative), so the prompt shows
// exactly what the peer wants to write before we write any of it.
function buildManifestTree(entries) {
  const root = { dirs: new Map(), files: [] };
  for (const e of entries || []) {
    const parts = String(e.path || '').split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let node = root;
    for (const seg of parts) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    }
    node.files.push({ name, size: e.size });
  }
  return root;
}
function renderManifestTree(node) {
  const ul = document.createElement('ul');
  ul.className = 'xfer-tree';
  for (const [name, child] of node.dirs) {
    const li = document.createElement('li');
    li.className = 'xfer-tree-dir';
    li.textContent = `\u{1F4C1} ${name}`;
    li.appendChild(renderManifestTree(child));
    ul.appendChild(li);
  }
  for (const f of node.files) {
    const li = document.createElement('li');
    li.className = 'xfer-tree-file';
    li.textContent = `${f.name} — ${formatBytes(f.size)}`;
    ul.appendChild(li);
  }
  return ul;
}

// req.jobId is the REAL persisted transfer jobId (main's requestReceiveConsent).
// Only one prompt at a time; a second offer mid-prompt is out of scope here.
let pendingConsentId = null;
window.farsightIpc.onTransferConsent((req) => {
  if (!req || typeof req.jobId !== 'string' || !req.manifest) return;
  pendingConsentId = req.jobId;
  const manifest = req.manifest;
  const n = manifest.totalFiles ?? (manifest.entries || []).length;
  consentSummaryEl.textContent = `${n} file${n === 1 ? '' : 's'} · ${formatBytes(manifest.totalBytes ?? 0)}`;
  consentDestEl.textContent = req.destDir || '';
  consentTreeEl.replaceChildren();
  consentTreeEl.appendChild(renderManifestTree(buildManifestTree(manifest.entries)));
  consentModalEl.hidden = false;
  // Bring the Transfers page up so the accepted transfer's progress is visible.
  showPage('transfers');
});
function respondToTransferConsent(accept) {
  if (!pendingConsentId) return;
  window.farsightIpc.respondConsent({ jobId: pendingConsentId, accept });
  pendingConsentId = null;
  consentModalEl.hidden = true;
  if (accept) refreshTransfersList();
}
document.getElementById('transfer-consent-accept').addEventListener('click', () => respondToTransferConsent(true));
document.getElementById('transfer-consent-reject').addEventListener('click', () => respondToTransferConsent(false));

// jobId -> { jobId, direction, target, manifest, progress, state, createdAt }.
// Seeded from transferList() (persisted jobs-store records) and kept live via
// onTransferEvent while this session's own sends are running. NOTE: the
// jobs-store record's `peer` field is always `{}` (transfer-service.js doesn't
// persist the target id/password), so a job loaded fresh from disk (e.g. after
// an app restart) shows "Unknown peer" until this session sends to it again —
// flagged in the report as a real gap, not something this UI phase can fix
// without a transfer-service/jobs-store schema change.
const transferJobs = new Map();

// Per-job rolling rate estimators — the event stream carries no timestamps, so
// arrival time is stamped here as events land.
const sendRateEstimators = new Map(); // jobId -> estimator
function sendEstimatorFor(jobId) {
  if (!sendRateEstimators.has(jobId)) sendRateEstimators.set(jobId, createRateEstimator({ windowMs: 5000 }));
  return sendRateEstimators.get(jobId);
}

function fmtCount(manifest) {
  if (!manifest) return '';
  const n = manifest.totalFiles ?? 0;
  return `${n} file${n === 1 ? '' : 's'}`;
}

// Friendly text for the signaling/transfer error reasons a send can surface.
const XFER_ERROR_LABELS = {
  host_offline: 'host is offline',
  bad_password: 'wrong password',
  transfer_timeout: 'the host didn’t respond',
  no_response: 'the host didn’t respond',
  connection_lost: 'the connection dropped',
  busy: 'the host is busy',
  locked: 'too many attempts — locked',
  rate_limited: 'rate limited — try again shortly',
};

// Human-readable status. 'awaiting-approval' is the crucial one: a send sits
// here — NOT "active" — until the host actually accepts (the sender's 'accepted'
// lifecycle event). Terminal states carry any error/decline reason.
function stateLabel(j) {
  // The file count is still worth showing (it's the intuitive "how far along"
  // signal, and it's what the 'done' label reads), but it is no longer the
  // PRIMARY one: sendDetailText leads with bytes/speed/ETA. A byte bar used to
  // read very differently from the receiver's — the sender counted only
  // remaining bytes and jumped a whole file at a time — so file-count was the
  // only honest common ground. transfer-engine now reports absolute, continuous
  // bytes on both sides, so bytes agree end-to-end AND keep moving inside one
  // huge file, which a file count cannot do.
  const p = j.progress;
  const total = p && Number.isFinite(p.filesTotal) ? p.filesTotal
    : (j.manifest && (j.manifest.totalFiles ?? (j.manifest.entries || []).length));
  const hasCount = Number.isFinite(total) && total > 0;
  switch (j.state) {
    case 'awaiting-approval': return 'Waiting for approval…';
    case 'interrupted': return `Interrupted — will resume${sendDetailText(j) ? ` · ${sendDetailText(j)}` : ''}`;
    case 'reconnecting': return 'Reconnecting…';
    case 'active': return sendDetailText(j) ? `Transferring · ${sendDetailText(j)}` : 'Transferring…';
    case 'finishing': return 'Finishing — verifying on host…';
    case 'done': return hasCount ? `Completed · ${total} file${total === 1 ? '' : 's'}` : 'Completed';
    case 'declined': return 'Declined by host';
    case 'canceled': return 'Canceled';
    case 'error': return `Failed${j.error ? ` — ${XFER_ERROR_LABELS[j.error] || j.error}` : ''}`;
    default: return j.state || 'Transferring…';
  }
}

// Byte fraction: the sender now reports absolute bytes over the full manifest
// (transfer-engine), the same denominator the receiver uses — so this agrees with
// the host's bar and keeps moving inside a single huge file.
function sendFraction(j) {
  const p = j.progress;
  if (p && Number.isFinite(p.total) && p.total > 0) return bytesDone(p) / p.total;
  return j.state === 'done' ? 1 : 0;
}

// "1.2 GB of 100 GB · 24.0 MB/s · ~1h 8m left · 3 / 2974 files"
function sendDetailText(j) {
  const p = j.progress;
  if (!p || !Number.isFinite(p.total) || p.total <= 0) return '';
  const done = bytesDone(p);
  const parts = [`${formatBytes(done)} of ${formatBytes(p.total)}`];
  if (Number.isFinite(j.rate) && j.rate > 0) {
    parts.push(formatRate(j.rate));
    const eta = etaSeconds(p.total - done, j.rate);
    if (eta !== null && j.state === 'active') parts.push(`~${formatDuration(eta)} left`);
  }
  if (Number.isFinite(p.filesTotal) && p.filesTotal > 1) {
    parts.push(`${filesDone(p)} / ${p.filesTotal} files`);
  }
  return parts.join(' · ');
}

function jobRow(j) {
  const row = document.createElement('div');
  row.className = 'host-row xfer-row';

  const main = document.createElement('div');
  main.className = 'host-main';

  const title = document.createElement('div');
  title.className = 'host-name';
  const arrow = j.direction === 'recv' ? '↓' : '↑';
  // Label by WHAT is being transferred (file/folder name) — the peer id is often
  // unknown (not persisted for receives; lost across a restart). fmtCount adds the
  // file count for context.
  title.textContent = `${arrow} ${transferLabel(j)} · ${fmtCount(j.manifest)}`;

  const barWrap = document.createElement('div');
  barWrap.className = 'xfer-bar';
  const barFill = document.createElement('div');
  barFill.className = 'xfer-bar-fill';
  const fraction = sendFraction(j);
  barFill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  barWrap.appendChild(barFill);

  const meta = document.createElement('div');
  meta.className = 'host-meta';
  meta.textContent = stateLabel(j);

  main.append(title, barWrap, meta);

  const right = document.createElement('div');
  right.className = 'host-right';
  const active = !TERMINAL_TRANSFER_STATES.includes(j.state);
  if (active) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = async () => {
      cancelBtn.disabled = true;
      try { await window.farsightIpc.transferCancel(j.jobId); } catch { /* best effort */ }
      j.state = 'canceled';
      renderTransfers();
    };
    right.appendChild(cancelBtn);
  } else {
    // A finished/failed/canceled job: let it be removed from the list (deletes
    // its persisted record). Drop it from the local map so the row disappears
    // immediately, then re-render.
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-ghost';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = async () => {
      removeBtn.disabled = true;
      try { await window.farsightIpc.transferRemove(j.jobId); } catch { /* best effort */ }
      transferJobs.delete(j.jobId);
      sendRateEstimators.delete(j.jobId);
      renderTransfers();
    };
    right.appendChild(removeBtn);
  }

  row.append(main, right);
  return row;
}

// Remove every finished/failed/canceled job in one go. Active transfers are left
// untouched (they show Cancel, not Remove).
async function clearFinishedTransfers() {
  const finished = [...transferJobs.values()].filter((j) => TERMINAL_TRANSFER_STATES.includes(j.state));
  for (const j of finished) {
    try { await window.farsightIpc.transferRemove(j.jobId); } catch { /* best effort */ }
    transferJobs.delete(j.jobId);
    sendRateEstimators.delete(j.jobId);
  }
  renderTransfers();
}

function renderTransfers() {
  const jobs = [...transferJobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  transfersListEl.replaceChildren();
  transfersEmptyEl.hidden = jobs.length > 0;
  for (const j of jobs) transfersListEl.appendChild(jobRow(j));
}

async function refreshTransfersList() {
  let records = [];
  try { records = await window.farsightIpc.transferList(); } catch { /* ignore — panel just stays empty */ }
  for (const r of records) {
    const existing = transferJobs.get(r.jobId) || {};
    transferJobs.set(r.jobId, {
      ...existing,
      jobId: r.jobId,
      direction: r.dir === 'recv' ? 'recv' : 'send',
      manifest: existing.manifest || r.manifest,
      // Carry the persisted source paths + peer so the transfer keeps its
      // file/folder label (and peer) after an app restart, not "Unknown peer".
      sourceRoots: existing.sourceRoots || r.sourceRoots,
      peer: existing.peer || r.peer,
      // Prefer this session's live-tracked state while a send is still in
      // flight (waiting for approval or actively transferring); otherwise trust
      // the store's jobState. (The store has no 'awaiting-approval'/'declined'
      // — those are live-only; a declined send persists as 'error'.)
      state: ['active', 'awaiting-approval'].includes(existing.state) ? existing.state : (r.jobState || existing.state),
      createdAt: r.createdAt || existing.createdAt,
    });
  }
  renderTransfers();
}

// Live progress push from main (transfer-service's onEvent, forwarded per
// transfer-orchestrator's event shape plus jobId/direction). Completion comes
// from the real 'completed' event — the receiver's delivery ACK, sent only once
// every file is hash-verified on disk — NEVER from progress.fraction reaching 1,
// which means "all bytes pushed into the local send buffer", not "received"
// (declaring done on that lost the tail of a transfer). refreshTransfersList()'s
// jobState read is the fallback source of truth for terminal states.
window.farsightIpc.onTransferEvent((ev) => {
  if (!ev || typeof ev.jobId !== 'string') return;
  const existing = transferJobs.get(ev.jobId) || { jobId: ev.jobId, direction: ev.direction, state: 'awaiting-approval', createdAt: Date.now() };
  existing.direction = ev.direction || existing.direction;
  if (TERMINAL_TRANSFER_STATES.includes(existing.state)) { transferJobs.set(ev.jobId, existing); return; } // don't resurrect a finished job
  if (ev.type === 'accepted') {
    // The host approved — ONLY now is the transfer genuinely active.
    existing.state = 'active';
    // A receiver's 'accepted' carries the manifest so its row gets the file/
    // folder name + count from the first render, without waiting for a Refresh.
    if (ev.manifest) existing.manifest = ev.manifest;
  } else if (ev.type === 'interrupted') {
    // Only an own-fleet/contact drop actually resumes; an ad-hoc one is terminal.
    // The event carries `resumable` — honor it so an ad-hoc drop reads "Failed —
    // the connection dropped", not a "will resume" that never will.
    if (ev.resumable === false) {
      existing.state = 'error';
      existing.error = existing.error || 'connection_lost';
    } else {
      existing.state = 'interrupted';
    }
    existing.rate = null;
    sendEstimatorFor(ev.jobId).reset(); // a re-established run restarts the window
  } else if (ev.type === 'reconnecting') {
    existing.state = 'reconnecting';
  } else if (ev.type === 'all-sent') {
    // All bytes are on the wire, but NOT yet confirmed received+verified. Hold at
    // "Finishing" until the host's delivery ack ('completed') — do not claim done.
    if (ev.progress) existing.progress = ev.progress;
    existing.state = 'finishing';
  } else if (ev.type === 'completed') {
    existing.state = 'done'; // both sides agree: all files received and hashes verified
  } else if (ev.type === 'declined') {
    existing.state = 'declined';
  } else if (ev.type === 'canceled') {
    existing.state = 'canceled';
  } else if (ev.type === 'error') {
    existing.state = 'error';
    if (ev.reason) existing.error = ev.reason;
  } else if (ev.progress) {
    // Progress implies the peer accepted (bytes are flowing). Completion is
    // signaled by 'completed', NOT by fraction hitting 1 (that's "all sent", not
    // "received") — so never flip to done here.
    existing.progress = ev.progress;
    if (existing.state !== 'finishing') existing.state = 'active';
    existing.rate = sendEstimatorFor(ev.jobId).sample(bytesDone(ev.progress));
  }
  transferJobs.set(ev.jobId, existing);
  if (activePage === 'transfers') renderTransfers();
  renderRail();
  renderStatusBar();
});

// mode: 'files' (multi-select files) or 'folder' (one directory). Windows/Linux
// can't offer both in one dialog, so the panel has a button per mode.
async function doSend(mode) {
  const targetId = normalizeHostId(sendHostId.value);
  const candidates = passwordCandidates(sendHostPw.value);
  if (!isValidHostId(targetId)) { sendStatusEl.textContent = 'Invalid ID.'; return; }
  if (candidates.length === 0) { sendStatusEl.textContent = 'Enter the host password.'; return; }
  const paths = await window.farsightIpc.transferPickPaths(mode);
  if (!paths || paths.length === 0) return; // dialog cancelled — leave the form as-is
  sendFilesBtn.disabled = true;
  sendFolderBtn.disabled = true;
  sendStatusEl.textContent = 'Starting…';
  try {
    const res = await window.farsightIpc.transferSend({ target: { id: targetId, password: candidates[0] }, paths });
    if (res && res.jobId) {
      transferJobs.set(res.jobId, {
        jobId: res.jobId, direction: 'send', target: { id: targetId },
        manifest: res.manifest, state: 'awaiting-approval', createdAt: Date.now(),
      });
      sendStatusEl.textContent = `Waiting for ${targetId} to accept… (see Transfers)`;
    } else {
      sendStatusEl.textContent = (res && res.error) || 'Could not start the transfer.';
    }
  } catch {
    sendStatusEl.textContent = 'Could not start the transfer.';
  } finally {
    sendFilesBtn.disabled = false;
    sendFolderBtn.disabled = false;
  }
}
sendFilesBtn.addEventListener('click', () => doSend('files'));
sendFolderBtn.addEventListener('click', () => doSend('folder'));

// SP3 Phase 4: initiate a password-free own-fleet ("linked") transfer to a
// console device. Picks files (multi-select), starts a linked send (the worker
// authenticates via the device keypair — no session password), and drops the
// user into the Transfers panel to watch progress. `d.signalingId` is where the
// device is reachable; `d.id` is its stable deviceId (threaded for future
// presence-driven auto-resume record matching).
async function sendToFleetDevice(d, btn, mode = 'files') {
  const paths = await window.farsightIpc.transferPickPaths(mode);
  if (!paths || paths.length === 0) return; // dialog cancelled
  if (btn) btn.disabled = true;
  try {
    const res = await window.farsightIpc.transferSend({
      target: { id: d.signalingId, deviceId: d.id, linked: true }, paths,
    });
    showPage('home');
    if (res && res.jobId) {
      transferJobs.set(res.jobId, {
        jobId: res.jobId, direction: 'send', target: { id: d.name || d.signalingId },
        manifest: res.manifest, state: 'awaiting-approval', createdAt: Date.now(),
      });
      showPage('transfers');
    } else {
      setMsg(fleetError, (res && res.error) || 'Could not start the transfer.');
    }
  } catch {
    setMsg(fleetError, 'Could not start the transfer.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById('transfers-refresh').addEventListener('click', refreshTransfersList);
document.getElementById('transfers-clear').addEventListener('click', clearFinishedTransfers);

// ─── Shell router ────────────────────────────────────────────────────────────
// ONE source of truth for which page is visible. The old shell wrote the
// "hide every sibling" list out four times (openFleet/openContacts/
// openSendPanel/openTransfersPanel) plus a partial fifth in the change-server
// handler that forgot #account and #contacts-panel — which is exactly the bug
// class a router removes.
const shellEl = document.getElementById('shell');
const railEl = document.getElementById('rail');
const pageEls = new Map(
  SHELL_PAGES.map((p) => [p, document.getElementById(`page-${p}`)]),
);
let activePage = 'home';

// Per-page loaders. Kept here so showPage() is the only place that knows what a
// page needs on entry — the old open* functions each carried their own tail.
const PAGE_ENTER = {
  fleet: () => refreshAccountView(),
  people: () => loadContacts(),
  transfers: () => { sendStatusEl.textContent = ''; refreshTransfersList(); },
  settings: () => refreshSettingsView(),
};

function showPage(name) {
  if (!isShellPage(name)) return;
  activePage = name;
  for (const [page, el] of pageEls) el.hidden = page !== name;
  renderRail();
  const enter = PAGE_ENTER[name];
  if (enter) enter();
}

// page -> { btn, badge } built once by renderRail()'s first call, then updated
// in place on every later call. A keyboard user can be focused on a rail
// button when a transfer event lands (file-sent/file-done are per-file and
// UNTHROTTLED, unlike progress) — rebuilding the buttons via replaceChildren()
// on every call moved focus to <body> mid-transfer. Structure (five
// `.rail-item` buttons + the `.rail-gap` div after 'transfers', in
// SHELL_PAGES order) is built once from railItems() and never replaced;
// only the `.sel` class and the `.rail-badge` child are mutated thereafter.
const railButtons = new Map();

function buildRail() {
  for (const item of railItems({ active: activePage, transferCount: activeTransferCount([...transferJobs.values()]) })) {
    const b = document.createElement('button');
    b.className = `rail-item${item.selected ? ' sel' : ''}`;
    b.dataset.page = item.page;
    const icon = document.createElement('span');
    icon.className = 'rail-icon';
    icon.textContent = item.icon;
    const label = document.createElement('span');
    label.textContent = item.label;
    b.append(icon, label);
    let badge = null;
    if (item.badge !== null) {
      badge = document.createElement('span');
      badge.className = 'rail-badge';
      badge.textContent = String(item.badge);
      b.appendChild(badge);
    }
    b.onclick = () => showPage(item.page);
    railEl.appendChild(b);
    railButtons.set(item.page, { btn: b, badge });
    if (item.page === 'transfers') railEl.appendChild(Object.assign(document.createElement('div'), { className: 'rail-gap' }));
  }
}

function renderRail() {
  if (railButtons.size === 0) { buildRail(); return; }
  for (const item of railItems({ active: activePage, transferCount: activeTransferCount([...transferJobs.values()]) })) {
    const entry = railButtons.get(item.page);
    if (!entry) continue;
    entry.btn.classList.toggle('sel', item.selected);
    if (item.badge !== null) {
      if (entry.badge) {
        entry.badge.textContent = String(item.badge);
      } else {
        const badge = document.createElement('span');
        badge.className = 'rail-badge';
        badge.textContent = String(item.badge);
        entry.btn.appendChild(badge);
        entry.badge = badge;
      }
    } else if (entry.badge) {
      entry.badge.remove();
      entry.badge = null;
    }
  }
}

function refreshSettingsView() {
  document.getElementById('settings-signaling').textContent = signalingUrl || 'not configured';
}

// Eager init — MUST be the last thing in the file. refreshSignalingUrl() reaches
// showPage() → renderRail() → transferJobs, a const that is in its temporal dead
// zone until :909 executes. Running this at the old :154 position throws before
// the renderer ever finishes.
renderRail();
renderStatusBar();
refreshSignalingUrl();

// Positive-proof marker for test/shell-launch.probe.mjs (extended by
// test/host-capability.probe.mjs — unification step 3, Task 9 — to also prove
// the shell wires up "this machine as a host"). Set LAST, so its presence
// means every import above resolved AND the module ran to completion. CLAUDE.md:
// Electron's console-message does not fire on an ES-module resolution failure, so
// absence of errors proves nothing — only a value like this does.
//
// hasCredentialUi/hasConsentModal/hasControlToggle are synchronous DOM-presence
// checks — cheap and correct to compute right here. controlAllowed and
// hostRegistering are NOT known yet at this point (getControlAllowed() is an
// async IPC round-trip that refreshSignalingUrl()/refreshHostRegistration()
// above are still mid-flight on) — they start out null/false and syncHostMarker()
// (see above) overwrites them on this same object once the async registration
// path resolves and again on every later toggle. The probe polls for the
// non-null value rather than trusting whatever is here at first read.
window.__farsightShellReady = {
  pages: [...pageEls.keys()],
  railItems: railEl.children.length,
  statusSegments: statusbarEl.children.length,
  hasCredentialUi: !!(credIdEl && credPwEl && hostCredentialsEl),
  hasConsentModal: !!consentEl,
  hasControlToggle: !!controlToggleEl,
  controlAllowed: null,
  hostRegistering: false,
};
