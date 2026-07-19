// packages/controller/src/renderer/renderer.js
import { isValidHostId } from '@farsight/shared/host-id';
import { normalizeHostId, passwordCandidates, formatHostId } from '@farsight/shared/credentials-format';
import { isOlder } from '@farsight/shared/version';
import { createRateEstimator, etaSeconds, bytesDone, filesDone, formatBytes, formatRate, formatDuration, classifyDiskSpace } from '@farsight/shared/transfer-rate';
import { railItems, activeTransferCount, TERMINAL_TRANSFER_STATES, isShellPage, SHELL_PAGES } from '@farsight/shared/shell-nav';
import { buildStatusSegments } from '@farsight/shared/status-bar';
import { transferLabel } from '@farsight/shared/transfer-label';
// Task 10: the failed-file dedupe accumulator. Pure/runtime-agnostic,
// unit-tested in packages/shared/test.
import { upsertFailedFile } from '@farsight/shared/transfer-detail';
import { deckModel } from '@farsight/shared/transfer-deck';
import { pushSample, waveformPath } from '@farsight/shared/transfer-samples';
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
      // Plan 3 Task 4 (SP3 multi-flow): groupId/flowIndex/flowCount identify
      // which multi-flow group (if any) this request belongs to (undefined for
      // a legacy/solo transfer) — passed through verbatim so main's group-
      // rendezvous coordinator can fold N per-flow requests into one receive.
      [MSG.TRANSFER_REQUEST]: (m) => {
        window.farsightIpc.transferIncoming({ sessionId: m.sessionId, linked: !!m.linked, groupId: m.groupId, flowIndex: m.flowIndex, flowCount: m.flowCount });
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
// The diagnostics reference id is the ONLY handle support has on an uploaded
// bundle, and it's read off-device (e.g. a contact reads it to the maintainer),
// so make it one-tap copyable via the shared .cbtn[data-copy] handler instead of
// forcing anyone to transcribe an 8-char code. The raw id lives in the hidden
// menu-diag-id span (the copy handler reads its textContent); the button is
// revealed only on a successful upload.
const menuCopyDiagId = document.getElementById('menu-copy-diag-id');
const menuDiagId = document.getElementById('menu-diag-id');
menuSendDiagnostics.addEventListener('click', async () => {
  menuCopyDiagId.hidden = true; // a fresh attempt hides any prior id's copy button
  const res = await window.farsightIpc.sendDiagnostics();
  if (res.ok) {
    menuStatus.textContent = `Diagnostics sent (id ${res.id}).`;
    menuDiagId.textContent = res.id;
    menuCopyDiagId.hidden = false;
  } else if (res.error !== 'cancelled') {
    menuStatus.textContent = `Diagnostics upload failed: ${res.error}`;
  }
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
document.getElementById('menu-change-received-dir').addEventListener('click', async () => {
  await window.farsightIpc.chooseReceivedDir();
  refreshSettingsView();
});
document.getElementById('menu-reset-received-dir').addEventListener('click', async () => {
  await window.farsightIpc.resetReceivedDir();
  refreshSettingsView();
});
const parallelConnectionsInput = document.getElementById('settings-parallel-connections');
document.getElementById('menu-save-parallel-connections').addEventListener('click', async () => {
  // Clamp/validate in the UI too (main.js's parallel-connections:set handler
  // clamps again via resolveParallelConnections, so a bad value here is never
  // actually persisted out of range — this just keeps the field itself sane).
  const n = Math.min(32, Math.max(1, Math.round(Number(parallelConnectionsInput.value)) || 8));
  await window.farsightIpc.setParallelConnections(n);
  refreshSettingsView();
});
const rateLimitInput = document.getElementById('settings-rate-limit');
document.getElementById('menu-save-rate-limit').addEventListener('click', async () => {
  const n = Math.min(1000, Math.max(0, Math.round(Number(rateLimitInput.value)) || 0));
  await window.farsightIpc.setRateLimit(n);
  refreshSettingsView();
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
// A small up-arrow, rendered inline next to a device's version when an update is
// available — the subtle "there's a newer build" cue.
function makeUpdateIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'host-ver-ic');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '9');
  svg.setAttribute('height', '9');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', 'M12 20V6M6 12l6-6 6 6');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2.5');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

// Set the remote-update directive for a device, driven by clicking its version
// link. The host converges to the official feed on its next heartbeat (works
// even if it's offline now — it converges on return). NOT gated on "no session
// active" (CLAUDE.md): this is an explicit owner request. Mirrors the old
// Update-button flow, including the bounded re-poll so the row reflects the host
// coming back on the new version.
async function triggerRemoteUpdate(d, verEl) {
  // Optimistic pending look; the poll below rebuilds the row from server state.
  verEl.onclick = null;
  verEl.onkeydown = null;
  verEl.removeAttribute('role');
  verEl.removeAttribute('tabindex');
  verEl.title = '';
  verEl.className = 'host-ver host-ver--pending';
  verEl.replaceChildren(document.createTextNode(`v${d.appVersion} · updating…`));
  const res = await window.farsightIpc.accountRequestUpdate({ deviceId: d.id, targetVersion: appVersion });
  if (!res || !res.ok) {
    setMsg(fleetError, 'Couldn’t request the update. Check your connection.');
    loadFleet(); // rebuild the row back to the clickable link
    return;
  }
  let polls = 0;
  const t = setInterval(() => {
    // The fleet page may have been navigated away from (or a connect started,
    // which also leaves it) while this poll was running — bail out instead of
    // making IPC calls + DOM writes into a page nobody can see.
    if (activePage !== 'fleet') { clearInterval(t); return; }
    polls += 1; loadFleet(); if (polls >= 12) clearInterval(t);
  }, 5000);
}

// The device's version line. When the host lags this controller's build, the
// version itself becomes the update affordance — a subtle teal link with an
// up-arrow — instead of a separate "Update" button (which pushed the row's
// actions onto a second line).
function buildHostMeta(meta, d) {
  meta.replaceChildren();
  const updateAvailable = d.appVersion && appVersion && isOlder(d.appVersion, appVersion);
  const pending = updateAvailable && d.targetVersion && isOlder(d.appVersion, d.targetVersion);

  let verNode;
  if (!d.appVersion) {
    verNode = document.createTextNode('version unknown');
  } else if (pending) {
    verNode = document.createElement('span');
    verNode.className = 'host-ver host-ver--pending';
    verNode.textContent = `v${d.appVersion} · updating…`;
  } else if (updateAvailable) {
    verNode = document.createElement('span');
    verNode.className = 'host-ver host-update';
    verNode.setAttribute('role', 'button');
    verNode.tabIndex = 0;
    verNode.title = `Update to v${appVersion}`;
    verNode.append(`v${d.appVersion}`, makeUpdateIcon());
    const run = () => triggerRemoteUpdate(d, verNode);
    verNode.onclick = run;
    verNode.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } };
  } else {
    verNode = document.createTextNode(`v${d.appVersion}`);
  }
  meta.appendChild(verNode);
  const seen = lastSeenText(d);
  if (seen) meta.appendChild(document.createTextNode(' · ' + seen));
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
  buildHostMeta(meta, d);
  main.append(name, meta);

  const right = document.createElement('div');
  right.className = 'host-right';
  // Remote update: the "update available" affordance now lives in the version
  // line (buildHostMeta) — a subtle link instead of a button, so the row's
  // actions stay on one line. Online/offline needs no words — the .host-dot shows it.

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
const sendAdhocGoEl = document.getElementById('send-adhoc-go');
const sendAdhocGoFolderEl = document.getElementById('send-adhoc-go-folder');
const sendStatusEl = document.getElementById('send-status');
const transfersEmptyEl = document.getElementById('transfers-empty');

// ── SP3 file transfer (receive path, v2) ────────────────────────────────────
// The unified app is now also a transfer DESTINATION: main forwards an incoming
// offer here as a consent prompt (manifest preview) before anything touches
// disk. An own-fleet push auto-accepts in main and never reaches this modal.
const consentModalEl = document.getElementById('transfer-consent');
const consentSummaryEl = document.getElementById('transfer-consent-summary');
const consentDestEl = document.getElementById('transfer-consent-dest');
const consentSpaceEl = document.getElementById('transfer-consent-space');
const consentWarnEl = document.getElementById('transfer-consent-warning');
const consentTreeEl = document.getElementById('transfer-consent-tree');
const LOW_MARGIN_BYTES = 1024 * 1024 * 1024; // 1 GiB — warn if this little (or less) would remain

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
  const totalBytes = manifest.totalBytes ?? 0;
  const freeBytes = (typeof req.freeBytes === 'number') ? req.freeBytes : null;
  consentSpaceEl.textContent = freeBytes == null ? '' : `${formatBytes(freeBytes)} free`;
  const { status } = classifyDiskSpace({ totalBytes, freeBytes, lowMarginBytes: LOW_MARGIN_BYTES });
  if (status === 'insufficient') {
    consentWarnEl.hidden = false;
    consentWarnEl.classList.add('is-danger');
    consentWarnEl.textContent = `Not enough space — needs ${formatBytes(totalBytes)}, only ${formatBytes(freeBytes)} free.`;
  } else if (status === 'low-margin') {
    consentWarnEl.hidden = false;
    consentWarnEl.classList.remove('is-danger');
    consentWarnEl.textContent = `Low disk space — ${formatBytes(freeBytes - totalBytes)} would remain after this transfer.`;
  } else {
    consentWarnEl.hidden = true;
    consentWarnEl.classList.remove('is-danger');
    consentWarnEl.textContent = '';
  }
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
    case 'paused': return 'Paused';
    case 'reconnecting': return 'Reconnecting…';
    case 'active': return sendDetailText(j) ? `Transferring · ${sendDetailText(j)}` : 'Transferring…';
    case 'finishing': return 'Finishing — verifying on host…';
    case 'verifying': return 'Finishing — verifying received files…';
    case 'done': return hasCount ? `Completed · ${total} file${total === 1 ? '' : 's'}` : 'Completed';
    case 'completed_with_errors': return hasCount ? `Completed with errors · ${total} file${total === 1 ? '' : 's'}` : 'Completed with errors';
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

// Builds a Cancel (active) or Remove (terminal) button for jobId. Looked up by
// jobId at CLICK time (transferJobs.get), not captured by reference at build
// time — a stale captured job object could otherwise survive past a
// refreshTransfersList() that replaced the map entry with a new object.
function buildActionButton(jobId, active) {
  if (active) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = async () => {
      cancelBtn.disabled = true;
      try { await window.farsightIpc.transferCancel(jobId); } catch { /* best effort */ }
      const cur = transferJobs.get(jobId);
      if (cur) cur.state = 'canceled';
      renderTransfers();
    };
    return cancelBtn;
  } else {
    // A finished/failed/canceled job: let it be removed from the list (deletes
    // its persisted record). Drop it from the local map so the row disappears
    // immediately, then re-render.
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-ghost';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = async () => {
      removeBtn.disabled = true;
      try { await window.farsightIpc.transferRemove(jobId); } catch { /* best effort */ }
      transferJobs.delete(jobId);
      sendRateEstimators.delete(jobId);
      peakRates.delete(jobId);
      rateSamples.delete(jobId);
      renderTransfers();
    };
    return removeBtn;
  }
}

// Remove every finished/failed/canceled job in one go. Active transfers are left
// untouched (they show Cancel, not Remove). 'completed_with_errors' (F-A4) is
// terminal too — grouped alongside TERMINAL_TRANSFER_STATES ad hoc, the same
// way 'interrupted'/'paused' are handled elsewhere in this file, rather than
// widening the shared list.
async function clearFinishedTransfers() {
  const finished = [...transferJobs.values()].filter((j) => TERMINAL_TRANSFER_STATES.includes(j.state) || j.state === 'completed_with_errors');
  for (const j of finished) {
    try { await window.farsightIpc.transferRemove(j.jobId); } catch { /* best effort */ }
    transferJobs.delete(j.jobId);
    sendRateEstimators.delete(j.jobId);
    peakRates.delete(j.jobId);
    rateSamples.delete(j.jobId);
  }
  renderTransfers();
}

// Peak send rate per job — the deck shows the max rate seen, tracked here because
// the event stream carries no history (same reason as sendRateEstimators).
const peakRates = new Map(); // jobId -> peak bytes/sec
function peakRateFor(jobId, rate) {
  if (!Number.isFinite(rate) || rate <= 0) return peakRates.get(jobId) || 0;
  const next = Math.max(peakRates.get(jobId) || 0, rate);
  peakRates.set(jobId, next);
  return next;
}

// Rolling throughput samples per job for the deck waveform — the event stream
// carries no history, so accumulate our own {t, rate} ring (mirrors peakRates).
const rateSamples = new Map(); // jobId -> [{t, rate}]
function pushRateSample(jobId, rate) {
  const cur = rateSamples.get(jobId) || [];
  const next = pushSample(cur, Date.now(), rate, { maxAgeMs: 60000, maxLen: 240 });
  rateSamples.set(jobId, next);
  return next;
}

const xferDeckEl = document.getElementById('xfer-deck');

// The active head SEND is what the deck shows (receives live in the queue column).
// Awaiting-approval/reconnecting/finishing/verifying all still occupy the deck —
// only a terminal state or a receive is excluded. 'interrupted' is non-terminal
// but is routed to History as "Resuming" (Task 7) — excluding it here keeps an
// interrupted send from rendering in BOTH the deck (with a wrong "Transferring"
// pill) and History at the same time.
function activeDeckJob() {
  const all = [...transferJobs.values()];
  const live = (j) => !TERMINAL_TRANSFER_STATES.includes(j.state) && j.state !== 'interrupted' && j.state !== 'paused' && j.state !== 'completed_with_errors';
  // The deck shows the active SEND (the engine runs the oldest queued send first
  // -- FIFO -- and the deck follows suit). If nothing is sending, fall back to the
  // active RECEIVE so the RECEIVER gets the same rich deck (rate/waveform/progress),
  // not just the compact Receiving row. Send wins over receive when both run.
  const sends = all.filter((j) => j.direction !== 'recv' && live(j)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (sends.length) return sends[0];
  const recvs = all.filter((j) => j.direction === 'recv' && live(j)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return recvs[0] || null;
}

// One grid cell: a <span> (main value) + <small> (the " / total" suffix, if
// any) so a same-job patch can update the text without touching structure —
// mirrors the `.v small` CSS selector unchanged from the pre-refactor markup.
function buildDeckCell(k) {
  const c = document.createElement('div'); c.className = 'xfer-cell';
  const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
  const vv = document.createElement('div'); vv.className = 'v';
  const main = document.createElement('span');
  const small = document.createElement('small');
  vv.append(main, small);
  c.append(kk, vv);
  return { el: c, main, small };
}
function patchDeckCell(refs, value) {
  const v = value || '—';
  if (v.includes(' / ')) {
    const [a, b] = v.split(' / ');
    refs.main.textContent = a;
    refs.small.textContent = ` / ${b}`;
  } else {
    refs.main.textContent = v;
    refs.small.textContent = '';
  }
}

// Pause/Cancel — built ONCE per job (never recreated on a progress tick, see
// deckEls below). Both look up the job by jobId at CLICK time (transferJobs.get),
// same as buildActionButton's cancel branch — a stale captured job object could
// otherwise survive past a renderTransfers() that replaced the map entry.
function buildDeckCtl(jobId) {
  const ctl = document.createElement('div'); ctl.className = 'xfer-deck-ctl';
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'ic-btn pause';
  pauseBtn.textContent = '❚❚';
  pauseBtn.onclick = async () => {
    // Guard against a double-fire before the 'paused' event flips job.state;
    // the next patch re-enables it (or not) from the live state.
    pauseBtn.disabled = true;
    try { await window.farsightIpc.transferPause(jobId); } catch { /* best effort */ }
    renderTransfers();
  };
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ic-btn';
  cancelBtn.textContent = '✕';
  cancelBtn.onclick = async () => {
    cancelBtn.disabled = true;
    try { await window.farsightIpc.transferCancel(jobId); } catch { /* best effort */ }
    const cur = transferJobs.get(jobId);
    if (cur) cur.state = 'canceled';
    renderTransfers();
  };
  ctl.append(pauseBtn, cancelBtn);
  return { ctl, pauseBtn, cancelBtn };
}

// jobId -> live element refs for the deck currently on screen, valid only
// while BOTH the jobId AND the flow-lane COUNT match the previous render (the
// lane bars are the one piece of structure whose cardinality can change across
// ticks of the SAME job). `null` when the deck is hidden (no active send).
// onTransferEvent fires renderTransfers() per progress tick (~4/s while a send
// is active) — same shape of problem the statusbarSegs/railButtons comments
// above document: a plain rebuild-every-time (replaceChildren()) recreates the
// Pause/Cancel buttons on every tick, dropping focus AND swallowing an
// in-flight click (the old button is gone by the time the click handler would
// fire). So a same-job, same-lane-count tick instead PATCHES the cached refs
// in place; only a genuine structural change (job start/switch, or the
// flow-lane count changing) tears down and rebuilds via replaceChildren().
let deckEls = null;
// The flow-lane equalizer animates on its own rAF loop (not the ~4/s progress
// tick, which is too coarse for smooth motion). Each live lane's height waves;
// the wave AMPLITUDE scales with actual throughput, so the bars are tall+lively
// while bytes flow and calm+low when connected-but-idle/stalled -- i.e. they show
// connection (alive vs dead lane) AND actual transfer (how much is moving). Dead
// lanes stay a flat sliver. Honors prefers-reduced-motion (static pattern, no rAF).
let deckRaf = null;
const deckReduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function animateLanes(ts) {
  const d = deckEls;
  if (!d || !d.laneEls || !d.laneEls.length) { deckRaf = null; return; }
  const act = d.activity || 0; // 0 (idle/stalled) .. 1 (at peak throughput)
  for (let i = 0; i < d.laneEls.length; i += 1) {
    const el = d.laneEls[i];
    if (d.laneStates[i] === 'dead') { el.style.height = '4px'; continue; }
    const wave = 0.5 + 0.5 * Math.sin(ts * 0.005 + i * 0.8); // travelling wave, per-lane phase
    const amp = 2 + act * 28; // ~2px shimmer when idle -> up to 30px when flowing
    el.style.height = `${Math.round(5 + amp * wave)}px`;
  }
  deckRaf = requestAnimationFrame(animateLanes);
}

function startLaneAnim() {
  if (deckReduceMotion || deckRaf) return;
  if (!deckEls || !deckEls.laneEls || !deckEls.laneEls.length) return;
  deckRaf = requestAnimationFrame(animateLanes);
}

function buildDeck(job, m) {
  const frag = document.createElement('div');
  frag.className = 'xfer-deck-inner';

  const top = document.createElement('div'); top.className = 'xfer-deck-top';
  const topL = document.createElement('div');
  const name = document.createElement('div'); name.className = 'xfer-deck-name';
  const dir = document.createElement('span'); dir.className = 'dir';
  const nameText = document.createElement('span');
  name.append(dir, nameText);
  topL.append(name);
  const pill = document.createElement('span'); pill.className = 'xfer-pill';
  const pd = document.createElement('span'); pd.className = 'pd';
  const pillText = document.createElement('span');
  pill.append(pd, pillText);
  top.append(topL, pill);

  const rateRow = document.createElement('div'); rateRow.className = 'xfer-rate';
  const rateBig = document.createElement('span'); rateBig.className = 'xfer-rate-big';
  const rateUn = document.createElement('span'); rateUn.className = 'xfer-rate-un';
  const peak = document.createElement('span'); peak.className = 'xfer-rate-peak';
  const peakVal = document.createElement('b');
  peak.append(document.createTextNode('Peak'), peakVal);
  rateRow.append(rateBig, rateUn, peak);

  const bar = document.createElement('div'); bar.className = 'xfer-deck-bar';
  const barFill = document.createElement('div'); barFill.className = 'xfer-deck-bar-fill';
  bar.append(barFill);

  const grid = document.createElement('div'); grid.className = 'xfer-grid';
  const cTransferred = buildDeckCell('Transferred');
  const cFiles = buildDeckCell('Files');
  const cEta = buildDeckCell('Time left');
  const cElapsed = buildDeckCell('Elapsed');
  grid.append(cTransferred.el, cFiles.el, cEta.el, cElapsed.el);

  // Live throughput waveform (network rate). SVG paths set via setAttribute('d', ...)
  // -- CSP-safe, no inline style. Empty until a couple of samples exist.
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'xfer-wave');
  svg.setAttribute('viewBox', '0 0 600 64');
  svg.setAttribute('preserveAspectRatio', 'none');
  const areaP = document.createElementNS(svgNS, 'path');
  areaP.setAttribute('class', 'xfer-wave-area');
  const lineP = document.createElementNS(svgNS, 'path');
  lineP.setAttribute('class', 'xfer-wave-line');
  svg.append(areaP, lineP);

  frag.append(top, rateRow, svg, bar, grid);

  // Flow-lane equalizer + the Pause/Cancel ctl row. Always built (not just when
  // multi-flow) so Pause/Cancel are always present; lanes/meta are hidden via
  // CSSOM display when the job has no parallel flows (m.lanes.length === 0).
  const flows = document.createElement('div'); flows.className = 'xfer-deck-flows';
  const lanes = document.createElement('div'); lanes.className = 'xfer-lanes';
  const laneEls = m.lanes.map(() => {
    const bar2 = document.createElement('div'); bar2.className = 'xfer-lane';
    lanes.append(bar2);
    return bar2;
  });
  const meta = document.createElement('div'); meta.className = 'meta';
  const { ctl, pauseBtn, cancelBtn } = buildDeckCtl(job.jobId);
  flows.append(lanes, meta, ctl);
  frag.append(flows);

  xferDeckEl.replaceChildren(frag);

  deckEls = {
    jobId: job.jobId,
    laneCount: m.lanes.length,
    dir, nameText, pillText,
    rateBig, rateUn, peak, peakVal,
    barFill,
    cTransferred, cFiles, cEta, cElapsed,
    areaP, lineP,
    lanes, laneEls, meta,
    laneStates: m.lanes.map((l) => l.state), activity: 0,
    pauseBtn, cancelBtn,
  };
}

function patchDeck(job, m) {
  const d = deckEls;
  d.dir.textContent = m.arrow;
  d.nameText.textContent = `${transferLabel(job)} · ${fmtCount(job.manifest)}`;
  d.pillText.textContent = m.statePill;

  const rate = m.rateText ? m.rateText.replace(/\s*[A-Za-z/]+$/, '') : '—';
  const unit = m.rateText ? (m.rateText.match(/[A-Za-z/]+$/) || [''])[0] : '';
  d.rateBig.textContent = rate;
  d.rateUn.textContent = unit;
  d.peak.style.display = m.peakText ? '' : 'none';
  d.peakVal.textContent = m.peakText;

  d.barFill.style.width = `${Math.round(m.fraction * 100)}%`;

  patchDeckCell(d.cTransferred, m.transferredText || '—');
  patchDeckCell(d.cFiles, m.filesText || '—');
  patchDeckCell(d.cEta, m.etaText || '—');
  patchDeckCell(d.cElapsed, m.elapsedText || '—');

  const samples = rateSamples.get(job.jobId) || [];
  const wp = waveformPath(samples, 600, 64, { pad: 3 });
  d.areaP.setAttribute('d', wp.area);
  d.lineP.setAttribute('d', wp.line);

  d.lanes.style.display = m.lanes.length ? '' : 'none';
  d.meta.style.display = m.flowText ? '' : 'none';
  d.meta.textContent = m.flowText;
  // Feed the rAF equalizer: per-lane connection state + a throughput "activity"
  // (current rate / peak; 0 when idle or stalled). The animation loop reads these.
  d.laneStates = m.lanes.map((l) => l.state);
  const rateBps = Number.isFinite(job.rate) && job.rate > 0 ? job.rate : 0;
  const peakBps = Math.max(peakRates.get(job.jobId) || 0, rateBps, 1);
  d.activity = rateBps > 0 ? Math.max(0.1, Math.min(1, rateBps / peakBps)) : 0;
  m.lanes.forEach((l, i) => {
    const bar2 = d.laneEls[i];
    bar2.classList.toggle('dead', l.state === 'dead');
    if (l.state === 'dead') bar2.style.height = '4px';
    else if (deckReduceMotion) bar2.style.height = `${8 + (i % 5) * 5}px`; // static (no rAF)
    // else: animateLanes owns the live-lane heights.
  });

  // Pause is send-only (the engine can't pause a receive) -- hide it on a receive
  // deck. For a send, enable it only while actively transferring (not awaiting-
  // approval / reconnecting / finishing / verifying).
  d.pauseBtn.style.display = job.direction === 'recv' ? 'none' : '';
  d.pauseBtn.disabled = job.state !== 'active';
}

function renderDeck(job) {
  if (!job) { xferDeckEl.hidden = true; xferDeckEl.replaceChildren(); deckEls = null; return; }
  const m = deckModel(job, { now: Date.now(), peakRate: peakRateFor(job.jobId, job.rate) });
  xferDeckEl.hidden = false;

  if (deckEls && deckEls.jobId === job.jobId && deckEls.laneCount === m.lanes.length) {
    patchDeck(job, m);
  } else {
    buildDeck(job, m);
    patchDeck(job, m);
  }
  startLaneAnim(); // kick the equalizer rAF loop if it isn't already running
}

const xferQueueEl = document.getElementById('xfer-queue');

// Waiting-send order, as the engine's queue sees it — refreshed in
// refreshTransfersList() and right after every reorder click (see qRow's
// opts.reorder buttons below). Falls back to createdAt for a jobId this
// hasn't caught up to yet.
let lastQueueOrder = [];

// Persistent queue-row elements, keyed by jobId — mirrors deckEls' cache-and-
// patch pattern (see buildDeck/patchDeck above) so a row surviving between
// renders is PATCHED, not recreated: recreating it every tick (~4/s while a
// send is active) would drop a button's focus/in-flight click, and recreating
// it on a reorder would do the same to the very buttons that just fired.
const queueRowEls = new Map(); // jobId -> { row, mt, fill, pct, tagEl, actionBtn, ordUp, ordDown, shapeKey }
// Structural signature of the last renderQueue() rebuild (ordered
// "jobId:kind:action" list). Unchanged between two calls -> every row kept
// its group/position, so this tick only needs to PATCH volatile fields.
let lastQueueSig = null;

function qGroupHeader(text, right) {
  const h = document.createElement('div'); h.className = 'xfer-qgroup-h';
  const l = document.createElement('span'); l.textContent = text; h.append(l);
  if (right) { const r = document.createElement('span'); r.textContent = right; h.append(r); }
  return h;
}

// Structural signature of a row's optional sub-elements (mini bar, tag,
// action button, reorder arrows). renderQueue's rebuild loop only REUSES a
// cached row for a persisting jobId when this key still matches — keying
// reuse on jobId alone let a job's ORIGINAL shape (e.g. a receive's mini bar,
// no tag/action) persist forever after its kind changed (recv -> done), since
// patchQRow only mutates already-existing sub-elements and never creates a
// missing tag/action-button or removes a stale mini-bar/reorder-control.
function qShapeKey(opts) {
  return `${opts.cls || ''}:${!!opts.mini}:${!!opts.tag}:${opts.action || ''}:${!!opts.reorder}:${!!opts.resumeAction}`;
}

// Builds a brand-new row + its cache-able refs. Called for a jobId that
// isn't already in queueRowEls, OR whose cached row's shape no longer
// matches (its kind changed) — an existing row is reused (moved), not
// rebuilt, only when both jobId AND shape match; see renderQueue below.
function qRow(j, opts = {}) {
  const row = document.createElement('div');
  row.className = `xfer-qrow${opts.cls ? ` ${opts.cls}` : ''}`;
  const m = document.createElement('div'); m.className = 'm';
  const nm = document.createElement('div'); nm.className = 'nm';
  const dir = document.createElement('span'); dir.className = 'dir';
  dir.textContent = j.direction === 'recv' ? '↓' : '↑';
  nm.append(dir, document.createTextNode(`${transferLabel(j)}`));
  const mt = document.createElement('div'); mt.className = 'mt'; mt.textContent = opts.meta || fmtCount(j.manifest);
  m.append(nm, mt);
  row.append(m);

  let fill = null;
  let pct = null;
  if (opts.mini) {
    const wrap = document.createElement('div'); wrap.className = 'xfer-miniwrap';
    const mini = document.createElement('div'); mini.className = 'xfer-mini';
    fill = document.createElement('div'); fill.className = 'xfer-mini-fill';
    mini.append(fill);
    pct = document.createElement('span'); pct.className = 'xfer-mini-pct';
    wrap.append(mini, pct);
    row.append(wrap);
  }

  // Reorder control — waiting sends only. jobId is closed over from this
  // build call and never changes for this row's lifetime (it's the
  // queueRowEls cache key), so the click handlers stay correct across every
  // later patch/reuse.
  let ordUp = null;
  let ordDown = null;
  if (opts.reorder) {
    const jobId = j.jobId;
    const ord = document.createElement('div'); ord.className = 'xfer-ord';
    ordUp = document.createElement('button');
    ordUp.type = 'button'; ordUp.className = 'xfer-ord-btn'; ordUp.textContent = '▲';
    ordUp.onclick = async () => {
      await window.farsightIpc.transferReorder(jobId, 'up');
      lastQueueOrder = await window.farsightIpc.transferQueueOrder();
      renderQueue();
    };
    ordDown = document.createElement('button');
    ordDown.type = 'button'; ordDown.className = 'xfer-ord-btn'; ordDown.textContent = '▼';
    ordDown.onclick = async () => {
      await window.farsightIpc.transferReorder(jobId, 'down');
      lastQueueOrder = await window.farsightIpc.transferQueueOrder();
      renderQueue();
    };
    ord.append(ordUp, ordDown);
    row.append(ord);
  }

  let tagEl = null;
  if (opts.tag) { tagEl = document.createElement('span'); tagEl.className = 'xfer-tag'; tagEl.textContent = opts.tag; row.append(tagEl); }
  let actionBtn = null;
  if (opts.action) { actionBtn = buildActionButton(j.jobId, opts.action === 'cancel'); row.append(actionBtn); }

  // Resume — paused sends only. jobId is closed over from this build call
  // (same pattern as ordUp/ordDown above), so the handler stays correct even
  // if the cached row is later reused for a patch on a fresh job object.
  let resumeBtn = null;
  if (opts.resumeAction) {
    const jobId = j.jobId;
    resumeBtn = document.createElement('button');
    resumeBtn.className = 'btn btn-primary';
    resumeBtn.textContent = 'Resume';
    resumeBtn.onclick = async () => {
      resumeBtn.disabled = true;
      let r;
      try { r = await window.farsightIpc.transferResume(jobId); } catch { r = { ok: false }; }
      if (r && r.ok === false) {
        if (sendStatusEl) sendStatusEl.textContent = r.reason === 'stale'
          ? "Can't resume after a restart — send the files again."
          : "Couldn't resume the transfer. Try again.";
        resumeBtn.disabled = false; // re-enable so the user can retry (a resumed job leaves the Paused group, so no double-fire)
      }
      renderTransfers();
    };
    row.append(resumeBtn);
  }

  return { row, mt, fill, pct, tagEl, actionBtn, resumeBtn, ordUp, ordDown, shapeKey: qShapeKey(opts) };
}

// Patches only the fields that can change tick-to-tick or reorder-to-reorder
// on an already-built row: meta text, mini bar width/pct, tag text, and the
// reorder buttons' first/last-position disabled state. Never touches
// structure (no createElement, no className swaps beyond the row's own
// group class, no onclick reassignment).
function patchQRow(refs, j, opts) {
  refs.row.className = `xfer-qrow${opts.cls ? ` ${opts.cls}` : ''}`;
  refs.mt.textContent = opts.meta || fmtCount(j.manifest);
  if (refs.fill && refs.pct) {
    const pctVal = Math.round(Math.min(1, Math.max(0, sendFraction(j))) * 100);
    refs.fill.style.width = `${pctVal}%`;
    refs.pct.textContent = `${pctVal}%`;
  }
  if (refs.tagEl && opts.tag) refs.tagEl.textContent = opts.tag;
  if (refs.ordUp) refs.ordUp.disabled = !!opts.firstWaiting;
  if (refs.ordDown) refs.ordDown.disabled = !!opts.lastWaiting;
}

// Interrupted-copy fix (spec §8): name the device when known.
function interruptedMeta(j) {
  const who = (j.peer && j.peer.id) ? ` when ${j.peer.id} is online` : ' when the device is online';
  return `Interrupted · will resume${who}`;
}

// Computes the three queue groups as a single ordered row-descriptor list
// (section for header placement, kind+action for the structural signature).
// Waiting sends are ordered by the engine's queue order (lastQueueOrder),
// falling back to createdAt for any jobId the cache hasn't caught up to.
function computeQueueRows() {
  const all = [...transferJobs.values()];
  const active = activeDeckJob();
  const orderIndex = new Map(lastQueueOrder.map((id, i) => [id, i]));
  // Paused sends get their own group (above "Up next") — excluded from
  // waitingSends so a paused job never double-renders (deck excludes it via
  // activeDeckJob, waitingSends excludes it here).
  const pausedSends = all
    .filter((j) => j.direction !== 'recv' && j.state === 'paused')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const waitingSends = all
    .filter((j) => j.direction !== 'recv' && !TERMINAL_TRANSFER_STATES.includes(j.state) && (!active || j.jobId !== active.jobId) && j.state !== 'interrupted' && j.state !== 'paused' && j.state !== 'completed_with_errors')
    .sort((a, b) => {
      const ai = orderIndex.has(a.jobId) ? orderIndex.get(a.jobId) : Infinity;
      const bi = orderIndex.has(b.jobId) ? orderIndex.get(b.jobId) : Infinity;
      if (ai !== bi) return ai - bi;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  // Interrupted receives belong in History (as "Resuming"), same as interrupted
  // sends — exclude them here so an interrupted receive renders ONCE, not once
  // under Receiving (mini bar) and again under History.
  // Exclude the receive that's showing in the deck (activeDeckJob can now be a
  // receive when nothing is sending) so it doesn't double-render here + in the deck.
  const receives = all.filter((j) => j.direction === 'recv' && !TERMINAL_TRANSFER_STATES.includes(j.state) && j.state !== 'interrupted' && j.state !== 'completed_with_errors' && (!active || j.jobId !== active.jobId));
  const history = all
    // 'completed_with_errors' (F-A4) is terminal and belongs in History like
    // 'error'/'done' — it's excluded from the base TERMINAL_TRANSFER_STATES
    // constant so it doesn't get treated as a clean 'done' anywhere the base
    // list is used for that purpose, but it must still land here.
    .filter((j) => TERMINAL_TRANSFER_STATES.includes(j.state) || j.state === 'interrupted' || j.state === 'completed_with_errors')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const rows = [];
  pausedSends.forEach((j) => rows.push({
    jobId: j.jobId, section: 'paused', kind: 'paused', action: 'resume', job: j,
    opts: { cls: 'paused', meta: 'Paused', tag: 'Paused', resumeAction: true },
  }));
  waitingSends.forEach((j, i) => rows.push({
    jobId: j.jobId, section: 'wait', kind: 'wait', action: 'cancel', job: j,
    opts: { meta: fmtCount(j.manifest), action: 'cancel', reorder: true, firstWaiting: i === 0, lastWaiting: i === waitingSends.length - 1 },
  }));
  receives.forEach((j) => rows.push({
    jobId: j.jobId, section: 'recv', kind: 'recv', action: 'none', job: j,
    opts: { cls: 'recv', meta: stateLabel(j), mini: true },
  }));
  history.forEach((j) => {
    if (j.state === 'interrupted') rows.push({ jobId: j.jobId, section: 'history', kind: 'warn', action: 'none', job: j, opts: { cls: 'warnrow', meta: interruptedMeta(j), tag: 'Resuming' } });
    else if (j.state === 'done') rows.push({ jobId: j.jobId, section: 'history', kind: 'done', action: 'remove', job: j, opts: { cls: 'done', meta: stateLabel(j), tag: 'Done', action: 'remove' } });
    // 'completed_with_errors' is terminal (F-A4) but not a clean failure — its
    // meta text already says "Completed with errors", so the tag must agree
    // instead of the generic 'Failed' a genuine error/cancel gets below.
    else if (j.state === 'completed_with_errors') rows.push({ jobId: j.jobId, section: 'history', kind: 'fail', action: 'remove', job: j, opts: { cls: 'fail', meta: stateLabel(j), tag: 'Errors', action: 'remove' } });
    else rows.push({ jobId: j.jobId, section: 'history', kind: 'fail', action: 'remove', job: j, opts: { cls: 'fail', meta: stateLabel(j), tag: 'Failed', action: 'remove' } });
  });
  return { rows, waitingCount: waitingSends.length };
}

function renderQueue() {
  const { rows, waitingCount } = computeQueueRows();
  const sig = rows.map((r) => `${r.jobId}:${r.kind}:${r.action}`).join('|');

  if (sig === lastQueueSig) {
    // Same jobs, same groups, same order as last render -> patch volatile
    // fields on the cached refs only. No DOM structure is touched, so a
    // reorder button mid-click (or any focused element) is untouched.
    for (const r of rows) {
      const refs = queueRowEls.get(r.jobId);
      if (refs) patchQRow(refs, r.job, r.opts);
    }
    return;
  }
  lastQueueSig = sig;

  // Structural/order change: build the final child list, reusing an existing
  // row element for any jobId that persists (pulled from queueRowEls) AND
  // whose shape (mini bar / tag / action / reorder controls) still matches
  // — this is what lets a row's ▲/▼ survive the very reorder click that just
  // fired, while still forcing a fresh build when a job's kind changes (e.g.
  // recv -> done needs a Done tag + Remove button the old row never had).
  const finalNodes = [];
  let lastSection = null;
  for (const r of rows) {
    if (r.section !== lastSection) {
      lastSection = r.section;
      if (r.section === 'paused') finalNodes.push(qGroupHeader('Paused'));
      else if (r.section === 'wait') finalNodes.push(qGroupHeader(`Up next · ${waitingCount} waiting`));
      else if (r.section === 'recv') finalNodes.push(qGroupHeader('Receiving'));
      else finalNodes.push(qGroupHeader('History'));
    }
    const newShapeKey = qShapeKey(r.opts);
    let refs = queueRowEls.get(r.jobId);
    if (refs && refs.shapeKey === newShapeKey) {
      // Safe reuse: same shape, just move the element and patch volatile
      // fields (className still needs reapplying — group/state class can
      // change without the shape changing, e.g. firstWaiting/lastWaiting).
      refs.row.className = `xfer-qrow${r.opts.cls ? ` ${r.opts.cls}` : ''}`;
    } else {
      // New job, or a persisting jobId whose shape changed underneath it —
      // discard the stale element (if any) and build fresh so the new
      // shape's tag/action/mini/reorder are actually present.
      refs = qRow(r.job, r.opts);
      queueRowEls.set(r.jobId, refs);
    }
    patchQRow(refs, r.job, r.opts);
    finalNodes.push(refs.row);
  }

  // Drop cache entries for jobIds no longer in the queue (finished+removed,
  // etc.) so queueRowEls never grows unbounded.
  const keptIds = new Set(rows.map((r) => r.jobId));
  for (const id of [...queueRowEls.keys()]) if (!keptIds.has(id)) queueRowEls.delete(id);

  // Remove only the DOM children that are NOT part of the new list (stale
  // headers from the previous rebuild, and rows whose job just dropped out).
  // Every reused row is in `keep`, so it is never detached from the document
  // — that's the actual mechanism that preserves its button's focus.
  const keep = new Set(finalNodes);
  for (const child of Array.from(xferQueueEl.children)) {
    if (!keep.has(child)) child.remove();
  }
  // append() on an already-attached node just relocates it (still connected
  // throughout) — walking the final order and appending each node in turn
  // sorts the container into place without ever fully detaching a kept node.
  for (const node of finalNodes) xferQueueEl.append(node);
}

function renderTransfers() {
  const jobs = [...transferJobs.values()];
  transfersEmptyEl.hidden = jobs.length > 0;
  renderDeck(activeDeckJob());
  document.getElementById('xfer-send')?.classList.toggle('compact', !!activeDeckJob());
  renderQueue();
}

async function refreshTransfersList() {
  let records = [];
  try { records = await window.farsightIpc.transferList(); } catch { /* ignore — panel just stays empty */ }
  try { lastQueueOrder = await window.farsightIpc.transferQueueOrder(); } catch { /* keep the previous order */ }
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
  if (TERMINAL_TRANSFER_STATES.includes(existing.state) || existing.state === 'completed_with_errors') { transferJobs.set(ev.jobId, existing); return; } // don't resurrect a finished job (F-A4: completed_with_errors is terminal too)
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
    // ev.ok is false when the receiver finished reconciling but a file
    // terminally failed (per-file I/O isolation) — F-A4: that must not read
    // as a clean 'done' live, same as the persisted jobState (jobStateForCompletion).
    existing.state = ev.ok === false ? 'completed_with_errors' : 'done';
  } else if (ev.type === 'declined') {
    existing.state = 'declined';
  } else if (ev.type === 'canceled') {
    existing.state = 'canceled';
  } else if (ev.type === 'error') {
    existing.state = 'error';
    if (ev.reason) existing.error = ev.reason;
  } else if (ev.type === 'verifying') {
    // The receiver is hash-verifying files it already received. Keep the last
    // progress but show a distinct finishing state — NOT "Transferring…" with a
    // live ETA, which is meaningless once bytes have stopped and hashing began.
    if (ev.progress) existing.progress = ev.progress;
    existing.state = 'verifying';
  } else if (ev.type === 'file-failed') {
    // Task 10 (transfer detail UI): accumulate TERMINALLY-failed files for the
    // detail panel's failed-files list. A file-failed carrying no `reason` is
    // retryable (transfer-service.js only treats a reason-carrying one as
    // terminal) — not a real failure yet, so it must not show up here.
    if (ev.reason) existing.failedFiles = upsertFailedFile(existing.failedFiles, { fileId: ev.fileId, reason: ev.reason });
  } else if (ev.type === 'paused') {
    existing.state = 'paused';
    existing.rate = null;
    sendEstimatorFor(ev.jobId).reset();
  } else if (ev.type === 'resumed') {
    existing.state = 'active';
  } else if (ev.progress) {
    // Progress implies the peer accepted (bytes are flowing). Completion is
    // signaled by 'completed', NOT by fraction hitting 1 (that's "all sent", not
    // "received") — so never flip to done here.
    existing.progress = ev.progress;
    if (existing.state !== 'finishing') existing.state = 'active';
    existing.rate = sendEstimatorFor(ev.jobId).sample(bytesDone(ev.progress));
    pushRateSample(ev.jobId, existing.rate);
  }
  transferJobs.set(ev.jobId, existing);
  if (activePage === 'transfers') renderTransfers();
  renderRail();
  renderStatusBar();
});

// Shared send launcher (Task 6): reused by drag/drop onto a recipient tile,
// click-to-browse on a recipient tile, and the ad-hoc Host ID form. Inserts
// the awaiting-approval job the same way the retired ad-hoc-only send helper
// (and sendToFleetDevice) used to.
async function startSendTo(target, paths, label) {
  if (!paths || paths.length === 0) return;
  if (sendStatusEl) sendStatusEl.textContent = 'Starting…';
  try {
    const res = await window.farsightIpc.transferSend({ target, paths });
    if (res && res.jobId) {
      transferJobs.set(res.jobId, { jobId: res.jobId, direction: 'send', target: { id: label || target.id }, manifest: res.manifest, state: 'awaiting-approval', createdAt: Date.now() });
      if (activePage !== 'transfers') showPage('transfers');
      renderTransfers();
      if (sendStatusEl) sendStatusEl.textContent = `Waiting for ${label || target.id} to accept…`;
    } else if (sendStatusEl) sendStatusEl.textContent = (res && res.error) || 'Could not start the transfer.';
  } catch { if (sendStatusEl) sendStatusEl.textContent = 'Could not start the transfer.'; }
}

// Turn a DataTransfer into absolute path strings via the preload bridge.
function droppedPaths(dt) {
  const files = dt && dt.files ? [...dt.files] : [];
  return files.map((f) => { try { return window.farsightIpc.pathForFile(f); } catch { return ''; } }).filter(Boolean);
}

// Wires dragover/dragleave/drop onto `el`. `resolveTarget()` returns
// `{ target, label }` for a specific recipient, or null/undefined for a
// generic drop zone with no resolvable recipient (ignored — matches the
// ad-hoc-tile / unresolved case). stopPropagation keeps a drop landing on a
// nested recipient tile from also re-triggering the outer send-zone's
// generic (no-op) handler.
function wireDrop(el, resolveTarget) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('xfer-drop-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('xfer-drop-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('xfer-drop-over');
    const paths = droppedPaths(e.dataTransfer);
    const t = resolveTarget();
    if (!t) return; // ad-hoc tile or unresolved: ignore drop
    startSendTo(t.target, paths, t.label);
  });
}

// mode: 'files' (multi-select files) or 'folder' (one directory). Windows/Linux
// can't offer both in one dialog, so the panel has a button per mode. Shared by
// the ad-hoc form's Send buttons AND the top-level Browse buttons — per Plan 2,
// Browse is intentionally minimal: it sends via the ad-hoc Host ID fields
// (reveals that panel if the fields are missing/invalid) rather than opening a
// richer "browse then pick a recipient" flow, which is a follow-up.
async function adhocSend(mode) {
  const targetId = normalizeHostId(sendHostId.value);
  const candidates = passwordCandidates(sendHostPw.value);
  if (!isValidHostId(targetId) || candidates.length === 0) {
    if (xferAdhocEl) xferAdhocEl.hidden = false;
    if (sendStatusEl) sendStatusEl.textContent = !isValidHostId(targetId) ? 'Invalid ID.' : 'Enter the host password.';
    return;
  }
  const paths = await window.farsightIpc.transferPickPaths(mode);
  if (!paths || paths.length === 0) return; // dialog cancelled — leave the form as-is
  const btns = [sendFilesBtn, sendFolderBtn, sendAdhocGoEl, sendAdhocGoFolderEl].filter(Boolean);
  for (const b of btns) b.disabled = true;
  try {
    await startSendTo({ id: targetId, password: candidates[0] }, paths, targetId);
  } finally {
    for (const b of btns) b.disabled = false;
  }
}
if (sendFilesBtn) sendFilesBtn.addEventListener('click', () => adhocSend('files'));
if (sendFolderBtn) sendFolderBtn.addEventListener('click', () => adhocSend('folder'));
if (sendAdhocGoEl) sendAdhocGoEl.addEventListener('click', () => adhocSend('files'));
if (sendAdhocGoFolderEl) sendAdhocGoFolderEl.addEventListener('click', () => adhocSend('folder'));

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

// ─── Send-zone recipient tiles (Task 5) ─────────────────────────────────────
// Drop-first send zone: instead of typing a Host ID, the Transfers page shows
// a tile per online fleet device / accepted contact (Task 6 wires drag/drop +
// click-to-send onto these). The ad-hoc Host ID form stays as a fallback
// behind a toggle for hosts that aren't in the fleet or contacts.
const xferRecipientsEl = document.getElementById('xfer-recipients');
const xferAdhocEl = document.getElementById('xfer-adhoc');

// Build the tier-shaped send target for a fleet device / contact (mirrors
// sendToFleetDevice / sendToContact).
function fleetTarget(d) { return { id: d.signalingId, deviceId: d.id, linked: true }; }
function contactTarget(c) { return { id: c.signalingId, deviceId: c.deviceId, linked: true, contact: true }; }

function recipTile(desc) {
  const t = document.createElement('div');
  t.className = `xfer-recip ${desc.online ? 'on' : 'off'}`;
  const av = document.createElement('div'); av.className = desc.kind === 'contact' ? 'av c' : 'av';
  av.textContent = (desc.name || '?').slice(0, 1).toUpperCase();
  const info = document.createElement('div');
  const rn = document.createElement('div'); rn.className = 'rn'; rn.textContent = desc.name;
  const rs = document.createElement('div'); rs.className = 'rs';
  const dot = document.createElement('span'); dot.className = 'rdot';
  rs.append(dot, document.createTextNode(`${desc.kind === 'contact' ? 'Contact' : 'Device'} · ${desc.online ? 'online' : 'offline'}`));
  info.append(rn, rs);
  t.append(av, info);
  t.__farsightRecipient = desc;
  // Task 6: drop a file/folder directly onto an online tile to send, or click
  // it to browse for paths instead — no Host ID typing either way. Offline
  // tiles resolve to null (wireDrop no-ops the drop) and the click is a no-op.
  wireDrop(t, () => (desc.online ? { target: desc.target, label: desc.name } : null));
  t.onclick = async () => {
    if (!desc.online) return;
    const paths = await window.farsightIpc.transferPickPaths('files');
    startSendTo(desc.target, paths, desc.name);
  };
  return t;
}

async function renderSendRecipients() {
  if (!xferRecipientsEl) return;
  let descs = [];
  try {
    const [fleetRes, myId, contactsRes] = await Promise.all([
      window.farsightIpc.accountFleet(), window.farsightIpc.connAuthDeviceId(), window.farsightIpc.accountContacts(),
    ]);
    const devices = (fleetRes && fleetRes.ok && fleetRes.data.devices || []).filter((d) => !myId || d.id !== myId);
    for (const d of devices) descs.push({ kind: 'fleet', name: d.name || d.signalingId, online: !!(d.online && d.signalingId && d.publicKey), target: fleetTarget(d) });
    const accepted = (contactsRes && contactsRes.ok && contactsRes.data.accepted) || [];
    for (const c of accepted) descs.push({ kind: 'contact', name: c.email, online: !!(c.online && c.signalingId), target: contactTarget(c) });
  } catch { /* not signed in / offline -- just show ad-hoc */ }
  xferRecipientsEl.replaceChildren();
  for (const d of descs) xferRecipientsEl.append(recipTile(d));
  // ad-hoc tile
  const adhoc = document.createElement('div'); adhoc.className = 'xfer-recip adhoc';
  adhoc.textContent = '+ Host ID…';
  adhoc.onclick = () => { if (xferAdhocEl) xferAdhocEl.hidden = !xferAdhocEl.hidden; };
  xferRecipientsEl.append(adhoc);
}

const xferAdhocToggleEl = document.getElementById('xfer-adhoc-toggle');
if (xferAdhocToggleEl) xferAdhocToggleEl.addEventListener('click', () => { if (xferAdhocEl) xferAdhocEl.hidden = !xferAdhocEl.hidden; });

// Whole send-zone card as a generic drop target: a drop that lands on a
// specific recipient tile is handled (and stops there — see wireDrop's
// stopPropagation) before it ever bubbles here. A drop on the card background
// or the ad-hoc "+ Host ID…" tile has no resolvable recipient, so this is a
// no-op — it just clears the highlight (matches Task 5/6's drop-first design:
// "focus the recipient row", not a silent dead end).
const xferSendZoneEl = document.getElementById('xfer-send');
if (xferSendZoneEl) wireDrop(xferSendZoneEl, () => null);

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
  transfers: () => { sendStatusEl.textContent = ''; refreshTransfersList(); renderSendRecipients(); },
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
  window.farsightIpc.getReceivedDir().then((p) => {
    document.getElementById('settings-received-dir').textContent = p || '';
  });
  window.farsightIpc.getParallelConnections().then((n) => {
    parallelConnectionsInput.value = n;
  });
  window.farsightIpc.getRateLimit().then((n) => { rateLimitInput.value = n; });
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
