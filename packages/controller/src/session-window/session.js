// packages/controller/src/session-window/session.js
// The remote-control session subsystem (unification step 2): video + input
// capture + peer connection + signaling + clipboard + stats + the in-session
// overlay + linked device-keypair auth, moved out of the shell's
// renderer/renderer.js into this window's own renderer. This is the most
// field-proven code in the project — input starvation, byte-routing, and
// linked-auth were all hard-won bugs here — so the function bodies below are
// moved BYTE-FOR-BYTE from renderer.js except three seams:
//   (A) entry: driven by farsightSession.onLaunch() instead of the shell's
//       #go click + module-scope signalingUrl/appVersion.
//   (B) status out: pushes to the shell via farsightSession.status() instead
//       of writing statusState/renderStatusBar (those stay in the shell —
//       there's no status bar in this window).
//   (C) doReconnect re-issues connectTo() locally instead of reaching into
//       #host-id/#host-pw/#go (those elements don't exist here).
import { createSignalingClient } from '../signaling-client.js';
import { createControllerPeer, describeConnectionState } from '../peer.js';
import { domEventToInput, videoContentRect } from '../input-capture.js';
import { MSG } from '@farsight/shared/protocol';
import { CONTROL } from '@farsight/shared/control-events';
import { isOlder } from '@farsight/shared/version';
import { runConnectionAuth } from '@farsight/shared/connection-auth';
import { sessionOverlayFor } from '../session-overlay.js';
import { extractStats, throughputKbps, formatQuality } from '../stats.js';
import { createRendererLogger } from './rlog.js';

const statusEl = document.getElementById('status');
const screenEl = document.getElementById('screen');
const video = document.getElementById('video');
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
      window.farsightSession.status({ peer: lastCreds.targetId || null, rttMs: cur.rttMs, width: cur.width, height: cur.height, transport: cur.transport });
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
const setActive = (v) => { window.farsightSession.setSessionActive(v); };

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
      const text = await window.farsightSession.readClipboard();
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
  window.farsightSession.status(null);
}

function doReconnect() {
  clog.info('reconnect');
  stopStatsPoll();
  stopClipboardSync();
  if (peer) { peer.close(); peer = null; }
  if (signal) { signal.close && signal.close(); signal = null; }
  overlayEl.hidden = true;
  // Reconnect with the same creds this window launched with. lastCreds.candidates
  // holds the password retry set (linked sessions carry an empty set).
  connectTo({ targetId: lastCreds.targetId, candidates: lastCreds.candidates || [], linked: lastCreds.linked });
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
  window.farsightSession.status({ peer: lastCreds.targetId || null });
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
      window.farsightSession.connAuthDeviceId(),
      window.farsightSession.connAuthPublicKey(),
    ]);
  } catch { /* leave null → handshake fails closed */ }
  await new Promise((res) => { if (channel.readyState === 'open') res(); else channel.addEventListener('open', res, { once: true }); });
  const fp = p.getFingerprints();
  console.debug('[connect-auth controller] fp', fp, 'deviceId', deviceId, 'hasKey', !!publicKey);
  try {
    await runConnectionAuth({
      role: 'controller', channel, deviceId, publicKey,
      localFingerprint: fp.local, remoteFingerprint: fp.remote,
      sign: (m) => window.farsightSession.connAuthSign(m),
      verify: (pk, m, s) => window.farsightSession.connAuthVerify(pk, m, s),
      isAccountKey: (pk) => window.farsightSession.connAuthIsAccountKey(pk),
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
  lastCreds.candidates = candidates; lastCreds.linked = linked;
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
          window.farsightSession.writeClipboard(evt.text);
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
          window.farsightSession.status(null);
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
    },
    [MSG.PEER_DISCONNECTED]: () => {
      clog.info('peer disconnected');
      setActive(false);
      window.farsightSession.status(null);
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

// Root renderer logger (forwards to the main-process file log over IPC — see
// rlog.js). newConnId() stamps a short, unique-enough-for-log-correlation id
// per connect attempt (renderer context: Math.random is fine here, this is
// NOT security-sensitive — just a log-grep key). clog is reassigned to a
// fresh conn:<id> scope at the start of each connectTo() attempt.
//
// The session window is driven entirely by the shell's launch message. It
// fetches its own signaling URL + app version (same IPC the shell uses) so the
// connect flow above is self-contained. rlog's send target is
// farsightSession.log (this window's preload bridge) — rlog.js's default send
// target (window.farsightIpc.log) doesn't exist here.
const rlog = createRendererLogger('', (entry) => window.farsightSession.log(entry));
const newConnId = (() => { let n = 0; return () => (++n).toString(36) + Math.random().toString(36).slice(2, 6); })();
let connId = newConnId();
let clog = rlog.child(`conn:${connId}`);
let signalingUrl = null;
let appVersion = null;

window.farsightSession.onLaunch(async ({ targetId, candidates, linked }) => {
  signalingUrl = await window.farsightSession.getSignalingUrl();
  appVersion = (await window.farsightSession.getAppVersion()) || null;
  lastCreds.targetId = targetId;
  // The shell already validated the id/password; candidates carry the retry set.
  connectTo({ targetId, candidates, linked });
});

// Positive-proof marker: set on the module's LAST line, so its presence means every
// import resolved and the module ran to completion (CLAUDE.md: console-message does
// not fire on an ESM resolution failure).
window.__farsightSessionReady = { hasVideo: !!video, hasScreen: !!screenEl };
