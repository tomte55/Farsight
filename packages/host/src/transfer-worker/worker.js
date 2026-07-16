// packages/host/src/transfer-worker/worker.js
// SP3 transfer worker renderer (design doc §3). A DUMB PIPE: it establishes
// the transfer rendezvous + RTCPeerConnection and shuttles bytes/frames
// between IPC (farsightTransfer, exposed by transfer-worker-preload.cjs) and
// the WebRTC data channels. It makes NO policy decisions and touches NO disk
// — main owns everything durable and decides everything (design doc
// "narrow-interface boundaries"). Mirrors the controller's
// packages/controller/src/transfer-worker/worker.js verbatim; the host's
// main.js only ever drives it with role:'attach' (see main.js's openChannel).
//
// Reuses signaling-client.js verbatim and mirrors peer.js's/host's peer.js
// ICE-restart + candidate-relay + datachannel patterns, but on three new
// channels: ft-ctrl (JSON control frames), ft-bulk (binary file bytes) and
// auth (own-fleet device-keypair handshake, design §4.3 — wiring the
// handshake itself is a later phase; this file only ensures the channel
// exists and is reachable).
import { createSignalingClient } from './signaling-client.js';
import { MSG } from '@farsight/shared/protocol';

let pc = null;
let signal = null;
let ctrlChannel = null;
let bulkChannel = null;
let authChannel = null;
// Ctrl frames the orchestrator emits before the ft-ctrl data channel is open —
// notably the initiator's very first OFFER frame, which main sends the instant
// the send starts, long before ICE/DTLS brings the channel up. Without this
// buffer those frames are dropped on the floor and the transfer deadlocks (the
// receiver never sees the offer, never consents, never accepts).
const pendingCtrlOut = [];

function reportState(state) {
  try { window.farsightTransfer.reportSessionState(state); } catch { /* guarded */ }
}

function wireDataChannel(ch) {
  if (ch.label === 'ft-ctrl') {
    ctrlChannel = ch;
    // Flush anything queued before the channel opened (e.g. the OFFER frame).
    const flush = () => { while (pendingCtrlOut.length) { try { ch.send(pendingCtrlOut.shift()); } catch { /* guarded */ } } };
    if (ch.readyState === 'open') flush(); else ch.addEventListener('open', flush);
    ch.addEventListener('message', (m) => {
      if (typeof m.data === 'string') { try { window.farsightTransfer.emitCtrl(m.data); } catch { /* guarded */ } }
    });
    return;
  }
  if (ch.label === 'ft-bulk') {
    try { ch.binaryType = 'arraybuffer'; } catch { /* guarded */ }
    // Mirrors peer.js's fileChannel threshold — backs the credit signal below.
    try { ch.bufferedAmountLowThreshold = 262144; } catch { /* guarded */ }
    bulkChannel = ch;
    ch.addEventListener('message', (m) => {
      if (m.data instanceof ArrayBuffer) { try { window.farsightTransfer.emitBulk(m.data); } catch { /* guarded */ } }
    });
    ch.addEventListener('bufferedamountlow', () => { try { window.farsightTransfer.emitCredit(); } catch { /* guarded */ } });
    return;
  }
  if (ch.label === 'auth') {
    authChannel = ch; // own-fleet handshake wiring lands in a later phase
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
  const { signalingUrl, role, targetId, password, linked, sessionId, version } = params || {};
  const isInitiator = role === 'initiator';

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
    },
    [MSG.ANSWER]: async (m) => { if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); },
    [MSG.CANDIDATE]: async (m) => { if (pc) { try { await pc.addIceCandidate(m.candidate); } catch { /* guarded */ } } },
    [MSG.ERROR]: (m) => reportState(`error:${(m && m.reason) || 'unknown'}`),
    [MSG.PEER_DISCONNECTED]: () => reportState('peer_disconnected'),
  });

  await signal.ready;
  if (isInitiator) {
    // Design §4.2/§4.3: kind:'transfer' does not consume the target's control
    // pairing — a host can serve a transfer while being controlled.
    signal.send(MSG.CONNECT, { targetId, password, kind: 'transfer', linked, version });
  } else {
    // Design §4.2 step 3: this transfer worker joins the session the peer's
    // initiator started, by the unguessable sessionId relayed to the host via
    // TRANSFER_REQUEST (see the host renderer's signaling handler).
    signal.send(MSG.ATTACH, { sessionId, version });
  }
});

// Frames main wants sent OUT over the data channels.
window.farsightTransfer.onSendCtrl((str) => {
  // Buffer until the ft-ctrl channel is actually open, then flush in order (see
  // pendingCtrlOut) — dropping pre-open frames deadlocked the transfer.
  try {
    if (ctrlChannel && ctrlChannel.readyState === 'open') ctrlChannel.send(str);
    else pendingCtrlOut.push(str);
  } catch { /* guarded */ }
});
window.farsightTransfer.onSendBulk((buf) => {
  try {
    if (!(bulkChannel && bulkChannel.readyState === 'open')) return;
    bulkChannel.send(buf);
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

// getStats bridge: the RTCPeerConnection lives here, not in main.
window.farsightTransfer.onStatsRequest(async () => {
  try {
    const report = pc ? await pc.getStats() : null;
    window.farsightTransfer.reportStats(report ? [...report.values()] : []);
  } catch { try { window.farsightTransfer.reportStats([]); } catch { /* guarded */ } }
});
