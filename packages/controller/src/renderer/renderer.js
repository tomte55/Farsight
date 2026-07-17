// packages/controller/src/renderer/renderer.js
import { createSignalingClient } from '../signaling-client.js';
import { createControllerPeer, describeConnectionState } from '../peer.js';
import { domEventToInput, videoContentRect } from '../input-capture.js';
import { MSG } from '@farsight/shared/protocol';
import { CONTROL } from '@farsight/shared/control-events';
import { isValidHostId } from '@farsight/shared/host-id';
import { normalizeHostId, passwordCandidates } from '@farsight/shared/credentials-format';
import { isOlder } from '@farsight/shared/version';
import { runConnectionAuth } from '@farsight/shared/connection-auth';
import { createRateEstimator, etaSeconds, bytesDone, formatBytes, formatRate, formatDuration } from '@farsight/shared/transfer-rate';
import { railItems, activeTransferCount, TERMINAL_TRANSFER_STATES, isShellPage, SHELL_PAGES } from '@farsight/shared/shell-nav';
import { sessionOverlayFor } from '../session-overlay.js';
import { extractStats, throughputKbps, formatQuality } from '../stats.js';
import { createRendererLogger } from './rlog.js';
import { buildStatusSegments } from '@farsight/shared/status-bar';

// Root renderer logger (forwards to the main-process file log over IPC — see
// rlog.js). newConnId() stamps a short, unique-enough-for-log-correlation id
// per connect attempt (renderer context: Math.random is fine here, this is
// NOT security-sensitive — just a log-grep key). clog is reassigned to a
// fresh conn:<id> scope at the start of each connectTo() attempt.
const rlog = createRendererLogger();
const newConnId = (() => { let n = 0; return () => (++n).toString(36) + Math.random().toString(36).slice(2, 6); })();
let connId = newConnId();
let clog = rlog.child(`conn:${connId}`);

const idInput = document.getElementById('host-id');
const statusEl = document.getElementById('status');
const screenEl = document.getElementById('screen');
const video = document.getElementById('video');
const setupEl = document.getElementById('setup');
const urlInput = document.getElementById('signaling-url');
const setupError = document.getElementById('setup-error');
let signalingUrl = null;
let peer = null, signal = null;
const overlayEl = document.getElementById('overlay');
const qualityEl = document.getElementById('quality');
const lastCreds = { targetId: '', password: '' };
let inputWired = false;

// Connection-quality readout: polls peer.getStats() every ~2s while a session
// is active. lastStatsSample carries the previous extractStats() result so
// throughputKbps() can diff byte/time deltas across ticks.
let statsTimer = null;
let lastStatsSample = null;
function stopStatsPoll() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  lastStatsSample = null;
  if (qualityEl) qualityEl.textContent = '';
}
function startStatsPoll() {
  stopStatsPoll();
  statsTimer = setInterval(async () => {
    if (!peer) { stopStatsPoll(); return; }
    try {
      const report = await peer.getStats();
      const cur = extractStats(report);
      const kbps = lastStatsSample ? throughputKbps(lastStatsSample, cur) : null;
      lastStatsSample = cur;
      if (qualityEl) qualityEl.textContent = formatQuality({ rttMs: cur.rttMs, kbps, width: cur.width, height: cur.height, transport: cur.transport }, clog.child('stats'));
      if (statusState.session) {
        Object.assign(statusState.session, { rttMs: cur.rttMs, width: cur.width, height: cur.height, transport: cur.transport });
        renderStatusBar();
      }
    } catch { /* never throw into the poller */ }
  }, 2000);
}
// Set when the host tells us it ended the session (HOST_ENDED). Suppresses the
// transient-disconnect/reconnect path so the terminal "Session ended" overlay
// isn't overwritten by the peer-close connectionstatechange that follows.
let sessionClosing = false;
// Session-active signal for the auto-updater: true while the remote screen is
// showing, false at every teardown path (host-ended, peer-disconnected,
// Disconnect). Keeps a pending update prompt from firing mid-session.
const setActive = (v) => { window.farsightIpc.setSessionActive(v); document.body.classList.toggle('in-session', v); };

// Clipboard sync: while the session view is up, poll the local OS clipboard and
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

const menuStatus = document.getElementById('menu-status');

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
  session: () => {}, // step 2 gives the session its own window; today it takes over
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
      peer: (j.target && j.target.id) || 'Unknown peer',
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
  if (configured) showPage(activePage);
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

// SP1: reflect the host's app version (relayed by the server on ICE_SERVERS)
// in the session bar, with a subtle note when the host is behind us — the
// groundwork the SP2 console turns into a one-click remote update.
const hostVersionEl = document.getElementById('host-version');
function showHostVersion(hostVersion) {
  if (!hostVersionEl) return;
  if (typeof hostVersion !== 'string' || !hostVersion) { hostVersionEl.textContent = ''; return; }
  const behind = isOlder(hostVersion, appVersion);
  hostVersionEl.textContent = behind ? `Host v${hostVersion} · update available` : `Host v${hostVersion}`;
  hostVersionEl.classList.toggle('outdated', behind);
}

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
  clog.info('session teardown');
  stopStatsPoll();
  stopClipboardSync();
  if (peer) { peer.close(); peer = null; }
  if (signal) { signal.close && signal.close(); signal = null; }
  overlayEl.hidden = true;
  screenEl.style.display = 'none';
  statusEl.textContent = '';
  setActive(false);
  statusState.session = null;
  renderStatusBar();
}

function doReconnect() {
  clog.info('reconnect');
  stopStatsPoll();
  stopClipboardSync();
  if (peer) { peer.close(); peer = null; }
  if (signal) { signal.close && signal.close(); signal = null; }
  overlayEl.hidden = true;
  idInput.value = lastCreds.targetId;
  document.getElementById('host-pw').value = lastCreds.password;
  document.getElementById('go').click();
}

// Connect-from-console (SP2 §4.4): a fresh base64 nonce for the device-keypair
// handshake (Web Crypto in the renderer).
function authNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

// Connect-from-console state: on the linked (password-free) path the session view
// is not revealed until the mutual keypair handshake passes (fails closed).
let linkedMode = false;
let linkedAuthOk = false;
let pendingStream = null;

// Reveal the live session view (video + input wiring). Extracted from onTrack so
// the linked path can defer it until the device handshake succeeds.
function revealSession(stream) {
  video.srcObject = stream;
  setActive(true);
  statusState.session = { peer: lastCreds.targetId || null };
  renderStatusBar();
  screenEl.style.display = 'block';
  document.getElementById('end').onclick = doClose;
  startStatsPoll();
  startClipboardSync();
  // Forward mouse/keyboard over the input data channel. Registered once
  // (revealSession can fire again on Reconnect); the handler reads the current
  // module-level `peer` and no-ops when there is none (e.g. after Close).
  if (!inputWired) {
    // Coalesce mousemove to at most one send per animation frame (raw mousemove
    // can fire ~165/sec on high-refresh displays). Non-move events are still
    // forwarded immediately, but flush any pending move first so ordering
    // (move-then-click) is preserved.
    let pendingMove = null, rafId = 0;
    const flushMove = () => {
      rafId = 0;
      if (!pendingMove || !peer) { pendingMove = null; return; }
      const e = pendingMove; pendingMove = null;
      const rect = videoContentRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
      const evt = domEventToInput(e, rect, clog.child('input'));
      if (evt && peer) peer.sendInput(evt);
    };
    const forward = (e) => {
      if (!peer) return;
      if (e.type === 'mousemove') { pendingMove = e; if (!rafId) rafId = requestAnimationFrame(flushMove); return; }
      if (pendingMove) { if (rafId) cancelAnimationFrame(rafId); flushMove(); } // preserve order: last move before this event
      if (['mousedown', 'mouseup', 'wheel'].includes(e.type)) e.preventDefault();
      const rect = videoContentRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
      const evt = domEventToInput(e, rect, clog.child('input'));
      if (evt) peer.sendInput(evt);
    };
    for (const t of ['mousemove', 'mousedown', 'mouseup', 'wheel']) video.addEventListener(t, forward, { passive: false });
    for (const t of ['keydown', 'keyup']) window.addEventListener(t, forward);
    inputWired = true;
  }
}

// Drive the controller side of the E2E device-keypair handshake over the peer's
// 'auth' channel, once it opens and both SDP descriptions are set (so fingerprints
// are available). On success reveal any video that already arrived; on failure
// close the session — the host is not verifiably one of the owner's devices.
async function runControllerAuth(p) {
  const channel = p.authChannel;
  // Pre-fetch our identity BEFORE the channel opens so the handshake starts with
  // no async gap (the pump attaches onmessage then sends hello synchronously).
  let deviceId = null, publicKey = null;
  try {
    [deviceId, publicKey] = await Promise.all([
      window.farsightIpc.connAuthDeviceId(),
      window.farsightIpc.connAuthPublicKey(),
    ]);
  } catch { /* leave null → handshake fails closed */ }
  await new Promise((res) => { if (channel.readyState === 'open') res(); else channel.addEventListener('open', res, { once: true }); });
  const fp = p.getFingerprints();
  console.debug('[connect-auth controller] fp', fp, 'deviceId', deviceId, 'hasKey', !!publicKey);
  try {
    await runConnectionAuth({
      role: 'controller', channel, deviceId, publicKey,
      localFingerprint: fp.local, remoteFingerprint: fp.remote,
      sign: (m) => window.farsightIpc.connAuthSign(m),
      verify: (pk, m, s) => window.farsightIpc.connAuthVerify(pk, m, s),
      isAccountKey: (pk) => window.farsightIpc.connAuthIsAccountKey(pk),
      nonce: authNonce, timeoutMs: 20000,
      log: clog.child('auth'),
    });
    if (peer !== p) return; // superseded/closed
    linkedAuthOk = true;
    if (pendingStream) { const s = pendingStream; pendingStream = null; revealSession(s); }
    else statusEl.textContent = 'Verified — connecting…';
  } catch (e) {
    if (peer !== p) return;
    const reason = (e && e.message) ? e.message : 'error';
    console.error('[connect-auth controller] failed:', reason);
    statusEl.textContent = `Couldn’t verify the host as your device (${reason}).`;
    doClose();
  }
}

// Shared connect path for BOTH the manual id+password form and the console's
// password-free "linked" Connect. Only the CONNECT payload (password vs linked)
// and the post-connection auth/reveal gating differ.
async function connectTo({ targetId, candidates, linked }) {
  // A new connect attempt: stamp a fresh correlation id so every log line from
  // this point (signaling/peer/auth/stats/input) can be grepped together.
  connId = newConnId();
  clog = rlog.child(`conn:${connId}`);
  clog.info('connect start');
  let pwIndex = 0;
  linkedMode = !!linked;
  linkedAuthOk = false;
  pendingStream = null;
  sessionClosing = false; // fresh attempt — clear any prior host-ended state
  if (hostVersionEl) hostVersionEl.textContent = ''; // clear any stale note
  statusEl.textContent = linked ? 'Connecting to your device…' : 'Connecting…';
  // SP1: announce our app version so the host (and server) learn who's connecting.
  const sendConnect = () => signal.send(MSG.CONNECT, linked
    ? { targetId, linked: true, version: appVersion || undefined }
    : { targetId, password: candidates[pwIndex], version: appVersion || undefined });

  // R-1: the server issues ICE/TURN servers only after successful auth. Build
  // the peer (and offer) once they arrive so the connection can use TURN.
  const startPeer = (iceServers) => {
    const thisPeer = createControllerPeer({
      sendSignal: (type, payload) => signal.send(type, payload),
      iceServers,
      onConnectionState: (s) => {
        if (peer !== thisPeer) return; // ignore callbacks from a replaced/closed peer
        if (sessionClosing) return; // host ended it — keep the terminal overlay
        clog.info('connection state ' + s);
        statusEl.textContent = describeConnectionState(s);
        // Only drive the overlay once the session view is up (video showing).
        if (screenEl.style.display === 'block') showOverlay(s);
      },
      // The host enumerates its monitors over the reliable control channel; build
      // the picker and send SELECT_MONITOR when the user switches.
      onControl: (evt) => {
        if (evt.type === CONTROL.CLIPBOARD) {
          lastClip = evt.text;
          window.farsightIpc.writeClipboard(evt.text);
          return;
        }
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
          statusState.session = null;
          renderStatusBar();
          stopStatsPoll();
          stopClipboardSync();
          if (peer) { peer.close(); peer = null; }
          if (screenEl.style.display === 'block') showOverlay(null, 'host_ended');
        }
      },
      onTrack: (stream) => {
        // Linked path: don't reveal the screen until the device handshake passes.
        if (linkedMode && !linkedAuthOk) { pendingStream = stream; statusEl.textContent = 'Verifying your device…'; return; }
        revealSession(stream);
      },
      log: clog.child('peer'),
    });
    peer = thisPeer;
    peer.start();
    // Linked connect: authenticate the host end-to-end over the 'auth' channel.
    if (linked) runControllerAuth(thisPeer);
  };

  signal = createSignalingClient(signalingUrl, {
    [MSG.ICE_SERVERS]: (m) => {
      // Reaching ICE_SERVERS means the server paired us. On the password path,
      // lock in the winning candidate (so Reconnect uses it directly).
      if (!linked) lastCreds.password = candidates[pwIndex];
      clog.info('paired target=' + targetId);
      showHostVersion(m.peerVersion);
      startPeer(m.iceServers || []);
    },
    [MSG.ANSWER]: (m) => peer.handleAnswer(m.sdp),
    [MSG.CANDIDATE]: (m) => peer.handleCandidate(m.candidate),
    [MSG.ERROR]: (m) => {
      // Compat shim: a bad_password may just mean this host predates the v1.4
      // password normalization — retry once with the next candidate before failing.
      if (!linked && m.reason === 'bad_password' && pwIndex + 1 < candidates.length) {
        pwIndex += 1;
        statusEl.textContent = 'Connecting…';
        sendConnect();
        return;
      }
      // On the linked path a bad_password means the host isn't accepting
      // password-free connects (e.g. it predates this feature) — not a real
      // password error; give an actionable message instead of "Wrong password".
      if (linked && m.reason === 'bad_password') {
        statusEl.textContent = 'This device isn’t reachable for password-free connect yet — update it to the latest version.';
        return;
      }
      statusEl.textContent = ERROR_TEXT[m.reason] || `Error: ${m.reason}`;
      statusState.signaling = 'error';
      renderStatusBar();
    },
    [MSG.PEER_DISCONNECTED]: () => {
      clog.info('peer disconnected');
      setActive(false);
      statusState.session = null;
      renderStatusBar();
      stopStatsPoll();
      stopClipboardSync();
      if (sessionClosing) return; // host already told us it ended — keep that overlay
      if (screenEl.style.display === 'block') showOverlay(null, 'peer_disconnected');
      else { statusEl.textContent = 'Host disconnected.'; }
    },
  }, { log: clog.child('signaling') });

  await signal.ready;
  // Host reacts to CONNECT (prepares its stream). On success the server sends
  // ICE_SERVERS, which triggers peer creation + OFFER above.
  sendConnect();
}

document.getElementById('go').addEventListener('click', async () => {
  if (!signalingUrl) return;
  const targetId = normalizeHostId(idInput.value);
  const typedPassword = document.getElementById('host-pw').value;
  // SP1 compat shim: try the normalized password first, then the raw typed
  // value (pre-v1.4 hosts registered the dashed literal). We advance through
  // these only on a bad_password reply, so a current host never triggers a retry.
  const candidates = passwordCandidates(typedPassword);
  lastCreds.targetId = targetId;
  lastCreds.password = typedPassword; // raw typed → Reconnect reproduces the same candidates
  if (!isValidHostId(targetId)) { statusEl.textContent = 'Invalid ID.'; return; }
  if (candidates.length === 0) { statusEl.textContent = 'Enter the host password.'; return; }
  connectTo({ targetId, candidates, linked: false });
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

const setMsg = (el, text, ok = false) => { el.textContent = text; el.style.color = ok ? 'var(--acc2)' : 'var(--danger-ink)'; };

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
    res = await window.farsightIpc.accountLogin({ email, password, deviceName: 'Controller', code });
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
  const res = await window.farsightIpc.accountFleet();
  if (!res.ok) {
    if (res.error === 'not_signed_in') { refreshAccountView(); return; }
    setMsg(fleetError, 'Couldn’t load your fleet. Check your connection.');
    return;
  }
  renderFleet(res.data.devices || []);
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
  const status = document.createElement('span');
  status.className = 'host-status';
  status.textContent = d.online ? 'Online' : 'Offline';
  right.appendChild(status);

  // Connect-from-console (SP2 §4.4): a password-free Connect for an online device
  // that has enrolled a key and reported where it's reachable (signalingId). The
  // handshake proves it's your own device; the host still prompts for consent.
  if (d.online && d.signalingId && d.publicKey) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary host-connect';
    btn.textContent = 'Connect';
    btn.onclick = () => { showPage('home'); connectTo({ targetId: d.signalingId, candidates: [], linked: true }); };
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
// interfere with) an open control session. Receiving isn't wired into this UI
// yet (main.js's consent always declines) — send-only for this phase.
const sendHostId = document.getElementById('send-host-id');
const sendHostPw = document.getElementById('send-host-pw');
const sendFilesBtn = document.getElementById('send-files-btn');
const sendFolderBtn = document.getElementById('send-folder-btn');
const sendStatusEl = document.getElementById('send-status');
const transfersListEl = document.getElementById('transfers-list');
const transfersEmptyEl = document.getElementById('transfers-empty');

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
    parts.push(`${Number.isFinite(p.filesSent) ? p.filesSent : 0} / ${p.filesTotal} files`);
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
  title.textContent = `${arrow} ${(j.target && j.target.id) || 'Unknown peer'} — ${fmtCount(j.manifest)}`;

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
  }

  row.append(main, right);
  return row;
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
  } else if (ev.type === 'interrupted') {
    // Recoverable own-fleet drop — the resume watcher will retry (not terminal).
    existing.state = 'interrupted';
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

// Positive-proof marker for test/shell-launch.probe.mjs. Set LAST, so its presence
// means every import above resolved AND the module ran to completion. CLAUDE.md:
// Electron's console-message does not fire on an ES-module resolution failure, so
// absence of errors proves nothing — only a value like this does.
window.__farsightShellReady = {
  pages: [...pageEls.keys()],
  railItems: railEl.children.length,
  statusSegments: statusbarEl.children.length,
};
