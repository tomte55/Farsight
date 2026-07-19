// packages/controller/src/transfer-worker/worker.js
// SP3 transfer worker renderer (design doc §3). A DUMB PIPE: it establishes
// the transfer rendezvous + RTCPeerConnection and shuttles bytes/frames
// between IPC (farsightTransfer, exposed by transfer-worker-preload.cjs) and
// the WebRTC data channels. It makes NO policy decisions and touches NO disk
// — main owns everything durable and decides everything (design doc
// "narrow-interface boundaries").
//
// Reuses signaling-client.js verbatim and mirrors peer.js's/host's peer.js
// ICE-restart + candidate-relay + datachannel patterns, but on three new
// channels: ft-ctrl (JSON control frames), ft-bulk (binary file bytes) and
// auth (own-fleet device-keypair handshake). On the `linked` path (SP3 Phase 4)
// the auth channel runs the same device-keypair handshake as connect-from-console
// and gates the manifest/bytes behind it (fails closed); the ad-hoc id+password
// path leaves the gate open and is a transparent pass-through.
import { createSignalingClient } from './signaling-client.js';
import { MSG } from '@farsight/shared/protocol';
import { runConnectionAuth } from '@farsight/shared/connection-auth';
import { parseDtlsFingerprint } from '@farsight/shared/connect-transcript';
import { createTransferAuthGate } from '@farsight/shared/transfer-auth-gate';
import { computeSendWindow, selectedPairRttSeconds } from '@farsight/shared/transfer-window';

let pc = null;
let signal = null;
let ctrlChannel = null;
let bulkChannel = null;
let authChannel = null;
// SP3 Phase 4 (own-fleet enablement): on the `linked` path the transfer runs the
// same device-keypair handshake as connect-from-console over the dedicated 'auth'
// channel, and NO manifest/bytes flow until it passes (fails closed). On the
// ad-hoc (id+password) path the gate starts 'open' and everything below is a
// transparent pass-through — the shipped flagship is byte-identical.
let isInitiator = false;
let linkedTransfer = false;
let authGate = createTransferAuthGate({ linked: false });
let authStarted = false;
let verifiedPeerKey = null; // SP3 Task 5: captured by the isAccountKey closure below, reported to main on auth-ok
let authDeviceId = null, authPublicKey = null; // pre-fetched so the pump has no async gap
const authEarly = [];      // auth-channel messages buffered before the pump wires onmessage (host-role hello)
const pendingCtrlIn = [];  // inbound ctrl frames held until authOk (linked)
// Ctrl frames the orchestrator emits before the ft-ctrl data channel is open —
// notably the initiator's very first OFFER frame, which main sends the instant
// the send starts, long before ICE/DTLS brings the channel up. Without this
// buffer those frames are dropped on the floor and the transfer deadlocks (the
// receiver never sees the offer, never consents, never accepts).
const pendingCtrlOut = [];

// Plan-1b Task 4: transport fault-injection state (test-hooks only — the
// onTestFault listener at the bottom is wired ONLY when the preload exposes it,
// i.e. this worker was launched with --ft-test-hooks=1). `stallFlow` holds
// outbound bulk here (granting no credit) so the flow stops moving bytes without
// dying; `resumeFlow` flushes it.
let testStalled = false;
const testStallQueue = [];

// ── Diagnostics ──────────────────────────────────────────────────────────────
// Counters + a 1s heartbeat, surfaced in the app log. If a transfer stalls the
// log shows exactly where: `tick` stopping = the hidden window was throttled/
// frozen; bulkIn/ctrlIn frozen = nothing arriving over the wire; bufAmt pinned
// high = backpressure not draining; bulkOut climbing but bulkIn flat = the
// send side is fine and the receive side is stuck.
let ftRole = '?';
let bulkIn = 0, bulkOut = 0, ctrlIn = 0, ctrlOut = 0;
function logStatus(extra) {
  try {
    window.farsightTransfer.logStatus({
      role: ftRole,
      conn: pc ? pc.connectionState : 'no-pc',
      ice: pc ? pc.iceConnectionState : '-',
      ctrlDC: ctrlChannel ? ctrlChannel.readyState : '-',
      bulkDC: bulkChannel ? bulkChannel.readyState : '-',
      bufAmt: bulkChannel ? bulkChannel.bufferedAmount : 0,
      bulkIn, bulkOut, ctrlIn, ctrlOut, pendCtrl: pendingCtrlOut.length,
      ...(extra || {}),
    });
  } catch { /* guarded */ }
}
setInterval(() => logStatus({ tick: true }), 1000);

// ── Adaptive ft-bulk send window ───────────────────────────────────────────────
// The window backing the credit backpressure (bufferedAmountLowThreshold) IS the
// per-flow throughput ceiling: at most that many bytes ride in flight, so
// throughput <= window / RTT. Size it to the bandwidth-delay product at the
// MEASURED selected-pair RTT (@farsight/shared/transfer-window), clamped to a safe
// band. Sampled off getStats on an interval; before the first sample the window is
// computeSendWindow(null) == the mid-band default. The credit check in onSendBulk
// reads bufferedAmountLowThreshold live, so updating it here is all that's needed.
// Like the heartbeat above, the interval is torn down when main destroys the
// worker window — no explicit clear.
let lastRttSeconds = null;
async function adaptSendWindow() {
  if (!pc || !bulkChannel || bulkChannel.readyState !== 'open') return;
  try {
    const report = await pc.getStats();
    const rtt = selectedPairRttSeconds([...report.values()]);
    if (rtt != null) lastRttSeconds = rtt;
    bulkChannel.bufferedAmountLowThreshold = computeSendWindow(lastRttSeconds);
  } catch { /* guarded */ }
}
setInterval(adaptSendWindow, 2000);

function reportState(state) {
  logStatus({ event: `conn:${state}` });
  try { window.farsightTransfer.reportSessionState(state); } catch { /* guarded */ }
}

// F-B3 (Plan 1b Task 7): the ONE seam that puts a ctrl frame on a data channel.
// A frame over the ~256KB WebRTC send() limit THROWS and kills the channel; every
// call site used to swallow that throw, so `ctrlOut` froze and main waited at 0%
// forever (a silent stall). Instead SURFACE it: log the reason and report a
// terminal channel error so main fails/re-dials the flow. Returns false on throw
// so a flush loop stops pumping into a now-dead channel. (bufferedAmount overflow
// or a transiently-not-open channel also land here — all better loud than silent.)
function rawSendCtrl(ch, str) {
  try {
    ch.send(str);
    ctrlOut += 1;
    return true;
  } catch (e) {
    const reason = (e && e.message) ? e.message : 'ctrl_send_failed';
    logStatus({ event: `dc-error:ctrl-send:${reason}` });
    reportState('error:ctrl_send');
    return false;
  }
}

// ── Own-fleet device-keypair handshake (SP3 Phase 4) ──────────────────────────
// Fresh base64 nonce (Web Crypto), same as the visible renderer's authNonce.
function authNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
// DTLS fingerprints from the exchanged SDP — the handshake binds them to defeat
// an SDP-swap MITM. Available once both descriptions are set.
function getFingerprints() {
  return {
    local: parseDtlsFingerprint(pc?.localDescription?.sdp || ''),
    remote: parseDtlsFingerprint(pc?.remoteDescription?.sdp || ''),
  };
}
// Release everything the gate held once auth passes: flush the buffered outbound
// ctrl (notably the initiator's manifest OFFER) and drain the buffered inbound
// ctrl up to main. Idempotent-safe (empties the queues).
function releaseAfterAuth() {
  if (ctrlChannel && ctrlChannel.readyState === 'open') {
    while (pendingCtrlOut.length) { if (!rawSendCtrl(ctrlChannel, pendingCtrlOut.shift())) break; } // F-B3: stop pumping a dead channel
  }
  while (pendingCtrlIn.length) { try { window.farsightTransfer.emitCtrl(pendingCtrlIn.shift()); ctrlIn += 1; } catch { /* guarded */ } }
}
// Run the handshake once the 'auth' channel exists and both SDPs are set (so
// fingerprints are known). Fails closed: on any failure the gate rejects, no
// bytes ever flow, and the connection is torn down with a surfaced reason.
async function maybeStartAuth() {
  if (!linkedTransfer || authStarted) return;
  if (!authChannel || !pc || !pc.localDescription || !pc.remoteDescription) return;
  authStarted = true;
  logStatus({ event: 'auth-start' });
  try {
    // pumpConnectionAuth wires channel.onmessage synchronously in its executor,
    // so the promise is returned with the handler attached; then we replay any
    // hello buffered on the auth channel before that (host-role race, mirrors
    // the visible renderer's runHostAuth).
    const p = runConnectionAuth({
      role: isInitiator ? 'controller' : 'host',
      channel: authChannel,
      deviceId: authDeviceId, publicKey: authPublicKey,
      localFingerprint: getFingerprints().local,
      remoteFingerprint: getFingerprints().remote,
      sign: (m) => window.farsightConnAuth.sign(m),
      verify: (pk, m, s) => window.farsightConnAuth.verify(pk, m, s),
      isAccountKey: (pk) => { verifiedPeerKey = pk; return window.farsightConnAuth.isTransferPeerKey(pk); },
      nonce: authNonce, timeoutMs: 20000,
    });
    while (authEarly.length) { const e = authEarly.shift(); try { authChannel.onmessage(e); } catch { /* guarded */ } }
    await p;
    authGate.resolve(true);
    try { window.farsightTransfer.reportPeerAuth({ publicKey: verifiedPeerKey }); } catch { /* guarded */ }
    logStatus({ event: 'auth-ok' });
    releaseAfterAuth();
  } catch (e) {
    authGate.resolve(false);
    const reason = (e && e.message) ? e.message : 'error';
    logStatus({ event: `auth-fail:${reason}` });
    // Surface as a rendezvous error so main fails the transfer with the reason
    // (mirrors the error:<reason> session-state contract), then tear down.
    reportState(`error:auth_${reason}`);
    try { signal && signal.close && signal.close(); } catch { /* guarded */ }
    try { pc && pc.close(); } catch { /* guarded */ }
  }
}

function wireDataChannel(ch) {
  ch.addEventListener('open', () => logStatus({ event: `dc-open:${ch.label}` }));
  ch.addEventListener('close', () => logStatus({ event: `dc-close:${ch.label}` }));
  // F-B3 (Plan 1b Task 7): a data channel that ERRORS is a dead flow — surface it
  // terminal so main fails/re-dials instead of stalling at 0% forever. Crucially
  // this catches the OVERSIZE-ctrl case: in Chromium the over-limit send() does NOT
  // throw synchronously (rawSendCtrl's try/catch can't see it) — the channel fires
  // this 'error' a tick later and closes. Only 'error' (abnormal) surfaces terminal;
  // a normal 'close' at teardown does not, so completion isn't mistaken for failure.
  ch.addEventListener('error', () => { logStatus({ event: `dc-error:${ch.label}` }); reportState(`error:dc_${ch.label}`); });
  if (ch.label === 'ft-ctrl') {
    ctrlChannel = ch;
    // Flush anything queued before the channel opened (e.g. the OFFER frame) —
    // but on the linked path NOT until the handshake passes (authGate 'open').
    // releaseAfterAuth() re-drives this once auth completes.
    const flush = () => {
      if (authGate.state !== 'open') return;
      while (pendingCtrlOut.length) { if (!rawSendCtrl(ch, pendingCtrlOut.shift())) break; } // F-B3: surface a throw, stop pumping a dead channel
    };
    if (ch.readyState === 'open') flush(); else ch.addEventListener('open', flush);
    ch.addEventListener('message', (m) => {
      if (typeof m.data !== 'string') return;
      // Hold inbound ctrl (the manifest OFFER, on the receiver) until authOk on
      // the linked path — the OFFER can arrive on ft-ctrl before the host's auth
      // resolves on the separate 'auth' channel. Failed auth → drop (fail closed).
      if (authGate.state === 'open') { ctrlIn += 1; try { window.farsightTransfer.emitCtrl(m.data); } catch { /* guarded */ } }
      else if (authGate.state === 'pending') pendingCtrlIn.push(m.data);
    });
    return;
  }
  if (ch.label === 'ft-bulk') {
    try { ch.binaryType = 'arraybuffer'; } catch { /* guarded */ }
    // Seed the send window at the mid-band default; adaptSendWindow() re-sizes it
    // to the bandwidth-delay product once the selected-pair RTT is measured. See
    // the adaptive block above and @farsight/shared/transfer-window.
    try { ch.bufferedAmountLowThreshold = computeSendWindow(lastRttSeconds); } catch { /* guarded */ }
    bulkChannel = ch;
    ch.addEventListener('message', (m) => {
      if (!(m.data instanceof ArrayBuffer)) return;
      // Bulk can only legitimately arrive after accept (post-OFFER, post-auth);
      // drop any pre-auth bulk on the linked path (fail closed). Ad-hoc: the gate
      // is always 'open', so this never drops.
      if (authGate.state !== 'open') return;
      bulkIn += 1; try { window.farsightTransfer.emitBulk(m.data); } catch { /* guarded */ }
    });
    ch.addEventListener('bufferedamountlow', () => { try { window.farsightTransfer.emitCredit(); } catch { /* guarded */ } });
    return;
  }
  if (ch.label === 'auth') {
    authChannel = ch;
    // Host-role race: buffer the initiator's hello the instant the channel
    // arrives, so it survives until maybeStartAuth wires the pump (mirrors the
    // visible renderer's runHostAuth early-buffer). Overwritten by the pump.
    if (linkedTransfer && !isInitiator) authChannel.onmessage = (e) => authEarly.push(e);
    maybeStartAuth();
  }
}

function createOffererChannels() {
  wireDataChannel(pc.createDataChannel('ft-ctrl', { ordered: true }));
  wireDataChannel(pc.createDataChannel('ft-bulk', { ordered: true }));
  wireDataChannel(pc.createDataChannel('auth', { ordered: true }));
}

// Debounced single ICE-restart on a persistent drop — same P-6 rationale as
// peer.js (WebRTC flaps disconnected->connected under transient loss).
// Only the initiator re-offers; the attacher waits for the re-offer.
function wireConnectionState(isInitiator) {
  let iceRestartTimer = null;
  const clearIceRestart = () => { if (iceRestartTimer) { clearTimeout(iceRestartTimer); iceRestartTimer = null; } };
  pc.addEventListener('connectionstatechange', () => {
    reportState(pc.connectionState);
    const recoverable = (s) => s === 'disconnected' || s === 'failed';
    if (!recoverable(pc.connectionState)) { clearIceRestart(); return; }
    if (!isInitiator || iceRestartTimer) return;
    iceRestartTimer = setTimeout(async () => {
      iceRestartTimer = null;
      if (!recoverable(pc.connectionState)) return; // recovered during the grace window
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        signal.send(MSG.OFFER, { sdp: offer.sdp });
      } catch { /* guarded */ }
    }, 2500);
  });
}

window.farsightTransfer.onStartRendezvous(async (params) => {
  // Plan 3 Task 4 (SP3 multi-flow): groupId/flowIndex/flowCount identify which
  // parallel-flow group (if any) this worker's rendezvous belongs to — undefined
  // for a plain single-flow send/receive (byte-identical to before). Threaded
  // through onto the CONNECT/ATTACH wire messages below; the signaling server
  // already relays them on CONNECT (Plan 2 Task 6) and ignores unknown fields
  // elsewhere, so this is a safe no-op for a legacy/solo transfer.
  const { signalingUrl, role, targetId, password, linked, sessionId, version, groupId, flowIndex, flowCount } = params || {};
  isInitiator = role === 'initiator';
  linkedTransfer = !!linked;
  authGate = createTransferAuthGate({ linked: linkedTransfer });
  authStarted = false;
  ftRole = role || '?';
  logStatus({ event: `rendezvous-start${linkedTransfer ? ':linked' : ''}` });
  // Pre-fetch our device identity up front so the handshake pump has no async
  // gap (a hello could otherwise be dropped during the fetch). Null → fails closed.
  if (linkedTransfer) {
    try {
      [authDeviceId, authPublicKey] = await Promise.all([
        window.farsightConnAuth.deviceId(),
        window.farsightConnAuth.publicKey(),
      ]);
    } catch { authDeviceId = null; authPublicKey = null; }
  }

  signal = createSignalingClient(signalingUrl, {
    [MSG.ICE_SERVERS]: async (m) => {
      pc = new RTCPeerConnection({ iceServers: m.iceServers || [] });
      pc.addEventListener('icecandidate', (e) => { if (e.candidate) signal.send(MSG.CANDIDATE, { candidate: e.candidate }); });
      pc.addEventListener('datachannel', (e) => wireDataChannel(e.channel));
      wireConnectionState(isInitiator);
      if (isInitiator) {
        createOffererChannels();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal.send(MSG.OFFER, { sdp: offer.sdp });
      }
      // Attacher: channels arrive via the 'datachannel' event once the
      // initiator's offer/answer exchange completes below.
    },
    [MSG.OFFER]: async (m) => {
      if (!pc) return; // OFFER should only arrive after ICE_SERVERS built the PC
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal.send(MSG.ANSWER, { sdp: answer.sdp });
      maybeStartAuth(); // attacher: both SDPs now set → fingerprints available
    },
    [MSG.ANSWER]: async (m) => {
      if (!pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      maybeStartAuth(); // initiator: both SDPs now set → fingerprints available
    },
    [MSG.CANDIDATE]: async (m) => { if (pc) { try { await pc.addIceCandidate(m.candidate); } catch { /* guarded */ } } },
    [MSG.ERROR]: (m) => reportState(`error:${(m && m.reason) || 'unknown'}`),
    [MSG.PEER_DISCONNECTED]: () => reportState('peer_disconnected'),
  }, {
    // F-B1: a signaling drop AFTER open surfaces as terminal so the supervisor
    // re-dials this slot (the worker needs signaling for ICE restart — a lost
    // socket means the flow can't recover on its own). Not fired on teardown.
    onClose: () => reportState('error:signaling_dropped'),
  });

  // F-B1: `ready` now REJECTS on error / close-before-open / connect-timeout
  // instead of hanging forever. Surface it as a terminal rendezvous error (the
  // supervisor re-dials the slot; a lone flow fails the transfer loudly) and
  // abort — never send CONNECT/ATTACH on a dead socket.
  try {
    await signal.ready;
  } catch (e) {
    reportState(`error:${(e && e.message) || 'signaling_failed'}`);
    try { signal.close(); } catch { /* guarded */ }
    return;
  }
  if (isInitiator) {
    // Design §4.2/§4.3: kind:'transfer' does not consume the target's control
    // pairing — a host can serve a transfer while being controlled.
    signal.send(MSG.CONNECT, { targetId, password, kind: 'transfer', linked, version, groupId, flowIndex, flowCount });
  } else {
    // Design §4.2 step 3: the target's transfer worker joins the session the
    // initiator started, by the unguessable sessionId relayed via TRANSFER_REQUEST.
    signal.send(MSG.ATTACH, { sessionId, version, groupId, flowIndex, flowCount });
  }
});

// Frames main wants sent OUT over the data channels. One seam (sendCtrlOut) so the
// oversize-ctrl fault (Task 4) and any Task-7 hardening live in one place (R7).
// Buffer until the ft-ctrl channel is open AND (linked) the handshake has passed —
// then flush in order (see pendingCtrlOut / releaseAfterAuth). Dropping pre-open
// frames deadlocked the transfer; sending the OFFER before auth would leak the
// manifest to an unverified peer.
function sendCtrlOut(str) {
  if (ctrlChannel && ctrlChannel.readyState === 'open' && authGate.state === 'open') rawSendCtrl(ctrlChannel, str);
  else pendingCtrlOut.push(str);
}
window.farsightTransfer.onSendCtrl((str) => sendCtrlOut(str));
window.farsightTransfer.onSendBulk((buf) => {
  try {
    // Task-4 stallFlow: hold the chunk and grant NO credit, so main's pool
    // backpressures this flow (its per-chunk credit await pends) without losing
    // the byte — resumeFlow sends it and grants the credit.
    if (testStalled) { testStallQueue.push(buf); return; }
    if (authGate.state !== 'open') return; // linked: no bytes before auth passes
    if (!(bulkChannel && bulkChannel.readyState === 'open')) return;
    bulkChannel.send(buf); bulkOut += 1;
    // Credit-based backpressure grants exactly one credit per chunk. Grant it NOW
    // if the channel still has room (buffered <= threshold); otherwise the
    // 'bufferedamountlow' handler grants it once the buffer drains. Granting ONLY
    // on bufferedamountlow deadlocked every sub-threshold send — the buffer never
    // rose above the threshold, so that event never fired and the sender's
    // per-chunk sendBulk await never resolved (the transfer hung right after accept).
    if (bulkChannel.bufferedAmount <= bulkChannel.bufferedAmountLowThreshold) {
      try { window.farsightTransfer.emitCredit(); } catch { /* guarded */ }
    }
  } catch { /* guarded */ }
});

// Plan-1b Task 4: transport fault injection. window.farsightTransfer.onTestFault
// is exposed by the preload ONLY when this worker was launched with
// --ft-test-hooks=1 (FARSIGHT_TEST_HOOKS=1); otherwise it is null and NO fault
// path is live here. Each fault reproduces a real silent-failure class so a
// real-wire test (Tasks 5-8) can prove the fix makes it loud.
function applyTestFault(cmd, args = {}) {
  logStatus({ event: `test-fault:${cmd}` });
  if (cmd === 'dropFlowSocket') {
    // F-B1: yank the signaling WebSocket out from under the worker as an
    // UNEXPECTED drop (dropForTest, NOT close() — close() marks it intentional and
    // would suppress the very failure this fault is meant to trigger).
    try { signal && signal.dropForTest && signal.dropForTest(); } catch { /* guarded */ }
  } else if (cmd === 'injectOversizeCtrl') {
    // F-B3: a single ctrl frame over the ~256KB WebRTC data-channel send() limit —
    // throws and KILLS the ctrl channel. Routed through the SAME sendCtrlOut seam
    // production ctrl frames use, so Task 7's hardening of that seam is what the
    // real-wire test exercises.
    const n = Number(args.bytes) > 0 ? Number(args.bytes) : 300000;
    sendCtrlOut('Z'.repeat(n));
  } else if (cmd === 'stallFlow') {
    testStalled = true;
  } else if (cmd === 'resumeFlow') {
    testStalled = false;
    while (testStallQueue.length) {
      const buf = testStallQueue.shift();
      try { bulkChannel.send(buf); bulkOut += 1; } catch { /* guarded */ }
      try { window.farsightTransfer.emitCredit(); } catch { /* guarded */ }
    }
  }
}
if (window.farsightTransfer.onTestFault) {
  window.farsightTransfer.onTestFault(({ cmd, args } = {}) => { try { applyTestFault(cmd, args); } catch { /* guarded */ } });
}

// getStats bridge: the RTCPeerConnection lives here, not in main.
window.farsightTransfer.onStatsRequest(async () => {
  try {
    const report = pc ? await pc.getStats() : null;
    window.farsightTransfer.reportStats(report ? [...report.values()] : []);
  } catch { try { window.farsightTransfer.reportStats([]); } catch { /* guarded */ } }
});
