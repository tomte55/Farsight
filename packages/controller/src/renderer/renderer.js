// packages/controller/src/renderer/renderer.js
import { createSignalingClient } from '../signaling-client.js';
import { createControllerPeer, describeConnectionState } from '../peer.js';
import { domEventToInput, videoContentRect } from '../input-capture.js';
import { MSG } from '@farsight/shared/protocol';
import { CONTROL } from '@farsight/shared/control-events';
import { isValidHostId } from '@farsight/shared/host-id';
import { normalizeHostId, passwordCandidates } from '@farsight/shared/credentials-format';
import { isOlder } from '@farsight/shared/version';
import {
  CHUNK_SIZE, MAX_FILE_SIZE, metaFrame, endFrame, parseFrame, sanitizeFilename, createReceiver,
} from '@farsight/shared/file-transfer';

// Bound on receiveState.chunks.length: legit transfers use CHUNK_SIZE chunks
// (~6400 for a 100 MB file), so this bounds the array against a peer sending
// a huge number of tiny chunks (O(n^2) reduce + per-ArrayBuffer overhead) even
// though each one is individually within the total-byte cap.
const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE) + 16;
import { sessionOverlayFor } from '../session-overlay.js';
import { extractStats, throughputKbps, formatQuality } from '../stats.js';

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
      if (qualityEl) qualityEl.textContent = formatQuality({ rttMs: cur.rttMs, kbps, width: cur.width, height: cur.height, transport: cur.transport });
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

// File transfer: bidirectional over the dedicated 'file' data channel (created
// in createControllerPeer; wired via peer.onFileMessage once the peer exists,
// alongside startStatsPoll/startClipboardSync). State is reset on every
// teardown path (doClose, doReconnect, HOST_ENDED, PEER_DISCONNECTED).
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
  if (!peer) { setFileStatus('Connect to a host first.'); return; }
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

// Wired via peer.onFileMessage(handleFileMessage) once the peer exists.
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
document.getElementById('menu-open-logs').addEventListener('click', () => { settingsMenu.classList.remove('open'); window.farsightIpc.openLogs(); });

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
document.getElementById('menu-change-server').addEventListener('click', async () => {
  settingsMenu.classList.remove('open');
  urlInput.value = (await window.farsightIpc.getSignalingUrl()) || '';
  connectEl.style.display = 'none';
  setupEl.hidden = false;
});
refreshSignalingUrl();

// Paint the subtle build-version label in the bottom-left corner. Also cache
// our own version for the SP1 version-aware handshake (sent on CONNECT and
// compared against the host's relayed version).
let appVersion = null;
window.farsightIpc.getAppVersion().then((v) => {
  appVersion = v || null;
  const el = document.getElementById('version-tag');
  if (el && v) el.textContent = `v${v}`;
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
  stopStatsPoll();
  stopClipboardSync();
  resetFileTransferState();
  if (peer) { peer.close(); peer = null; }
  if (signal) { signal.close && signal.close(); signal = null; }
  overlayEl.hidden = true;
  screenEl.style.display = 'none';
  connectEl.style.display = '';
  statusEl.textContent = '';
  setActive(false);
}

function doReconnect() {
  stopStatsPoll();
  stopClipboardSync();
  resetFileTransferState();
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
  connectEl.style.display = 'none';
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
      const evt = domEventToInput(e, rect);
      if (evt && peer) peer.sendInput(evt);
    };
    const forward = (e) => {
      if (!peer) return;
      if (e.type === 'mousemove') { pendingMove = e; if (!rafId) rafId = requestAnimationFrame(flushMove); return; }
      if (pendingMove) { if (rafId) cancelAnimationFrame(rafId); flushMove(); } // preserve order: last move before this event
      if (['mousedown', 'mouseup', 'wheel'].includes(e.type)) e.preventDefault();
      const rect = videoContentRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
      const evt = domEventToInput(e, rect);
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
  await new Promise((res) => { if (channel.readyState === 'open') res(); else channel.addEventListener('open', res, { once: true }); });
  const fp = p.getFingerprints();
  try {
    await runConnectionAuth({
      role: 'controller', channel,
      deviceId: await window.farsightIpc.connAuthDeviceId(),
      publicKey: await window.farsightIpc.connAuthPublicKey(),
      localFingerprint: fp.local, remoteFingerprint: fp.remote,
      sign: (m) => window.farsightIpc.connAuthSign(m),
      verify: (pk, m, s) => window.farsightIpc.connAuthVerify(pk, m, s),
      isAccountKey: (pk) => window.farsightIpc.connAuthIsAccountKey(pk),
      nonce: authNonce, timeoutMs: 15000,
    });
    if (peer !== p) return; // superseded/closed
    linkedAuthOk = true;
    if (pendingStream) { const s = pendingStream; pendingStream = null; revealSession(s); }
    else statusEl.textContent = 'Verified — waiting for the host to accept…';
  } catch {
    if (peer !== p) return;
    statusEl.textContent = 'Couldn’t verify the host as your device — connection blocked.';
    doClose();
  }
}

// Shared connect path for BOTH the manual id+password form and the console's
// password-free "linked" Connect. Only the CONNECT payload (password vs linked)
// and the post-connection auth/reveal gating differ.
async function connectTo({ targetId, candidates, linked }) {
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
          stopStatsPoll();
          stopClipboardSync();
          resetFileTransferState();
          if (peer) { peer.close(); peer = null; }
          if (screenEl.style.display === 'block') showOverlay(null, 'host_ended');
        }
      },
      onTrack: (stream) => {
        // Linked path: don't reveal the screen until the device handshake passes.
        if (linkedMode && !linkedAuthOk) { pendingStream = stream; statusEl.textContent = 'Verifying your device…'; return; }
        revealSession(stream);
      },
    });
    peer = thisPeer;
    peer.onFileMessage(handleFileMessage);
    peer.start();
    // Linked connect: authenticate the host end-to-end over the 'auth' channel.
    if (linked) runControllerAuth(thisPeer);
  };

  signal = createSignalingClient(signalingUrl, {
    [MSG.ICE_SERVERS]: (m) => {
      // Reaching ICE_SERVERS means the server paired us. On the password path,
      // lock in the winning candidate (so Reconnect uses it directly).
      if (!linked) lastCreds.password = candidates[pwIndex];
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
      statusEl.textContent = ERROR_TEXT[m.reason] || `Error: ${m.reason}`;
    },
    [MSG.PEER_DISCONNECTED]: () => {
      setActive(false);
      stopStatsPoll();
      stopClipboardSync();
      resetFileTransferState();
      if (sessionClosing) return; // host already told us it ended — keep that overlay
      if (screenEl.style.display === 'block') showOverlay(null, 'peer_disconnected');
      else { statusEl.textContent = 'Host disconnected.'; connectEl.style.display = ''; }
    },
  });

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
const accountEl = document.getElementById('account');
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

function openFleet() {
  connectEl.style.display = 'none';
  setupEl.hidden = true;
  accountEl.hidden = false;
  refreshAccountView();
}
function closeFleet() {
  accountEl.hidden = true;
  connectEl.style.display = '';
}

async function refreshAccountView() {
  const { signedIn } = await window.farsightIpc.accountStatus();
  acctSignin.hidden = signedIn;
  acctFleet.hidden = !signedIn;
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
  if (d.appVersion && appVersion && isOlder(d.appVersion, appVersion)) {
    const badge = document.createElement('span');
    badge.className = 'host-badge';
    badge.textContent = 'Update available';
    right.appendChild(badge);
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
    btn.onclick = () => { closeFleet(); connectTo({ targetId: d.signalingId, candidates: [], linked: true }); };
    right.appendChild(btn);
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

document.getElementById('menu-fleet').addEventListener('click', () => { settingsMenu.classList.remove('open'); openFleet(); });
document.getElementById('acct-close').addEventListener('click', closeFleet);
document.getElementById('acct-signout').addEventListener('click', async () => { await window.farsightIpc.accountLogout(); refreshAccountView(); });
document.getElementById('fleet-refresh').addEventListener('click', loadFleet);
acctSigninBtn.addEventListener('click', doSignIn);
document.getElementById('acct-register').addEventListener('click', doRegister);
document.getElementById('acct-forgot').addEventListener('click', doForgot);
for (const el of [acctPassword, acctCode, acctEmail]) {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
}

// Resume a persisted account session on launch so a signed-in controller starts
// reporting presence immediately (heartbeat), without waiting for the fleet panel
// to be opened. No stored token → no network call; status() just returns signed-out.
window.farsightIpc.accountStatus();
