// packages/controller/src/peer.js
import { MSG } from '@farsight/shared/protocol';
import { CONTROL, validateControlEvent } from '@farsight/shared/control-events';
import { parseDtlsFingerprint } from '@farsight/shared/connect-transcript';

// P-3: prefer VP8 then H264 (broad hardware-encoder coverage, low encode
// latency) by REORDERING (never excluding) the codec list on the video
// transceiver. The controller creates the offer, so its preference order
// drives negotiation.
function preferVideoCodecs(transceiver) {
  try {
    if (!transceiver || !transceiver.setCodecPreferences) return;
    const caps = (RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video'))
      || (RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video'));
    if (!caps || !caps.codecs) return;
    const rank = (c) => {
      const m = c.mimeType.toLowerCase();
      if (m === 'video/vp8') return 0;
      if (m === 'video/h264') return 1;
      return 2; // keep everything else, just after the preferred two
    };
    const ordered = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
    transceiver.setCodecPreferences(ordered);
  } catch { /* leave default negotiation */ }
}

// Pure mapping of RTCPeerConnection.connectionState to user-facing text.
export function describeConnectionState(state) {
  switch (state) {
    case 'new':
    case 'connecting': return 'Connecting…';
    case 'connected': return 'Connected.';
    case 'disconnected': return 'Connection lost — attempting to reconnect…';
    case 'failed': return 'Connection failed (firewall blocked / no route).';
    case 'closed': return 'Session closed.';
    default: return state;
  }
}

// Verbose diagnostic logging (see docs/private/superpowers): never log SDP or
// candidate strings — states/types/counts only.
function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

async function logSelectedPair(pc, log) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    log.info(`selected pair local=${local?.candidateType || '?'} remote=${remote?.candidateType || '?'} proto=${local?.protocol || '?'}`);
  } catch { /* stats unavailable */ }
}

export function attachPeerLogging(pc, log) {
  pc.addEventListener('iceconnectionstatechange', () => log.info(`ice ${pc.iceConnectionState}`));
  pc.addEventListener('connectionstatechange', () => {
    const s = pc.connectionState;
    (s === 'failed' ? log.warn : log.info).call(log, `conn ${s}`);
    if (s === 'connected') logSelectedPair(pc, log);
  });
  pc.addEventListener('signalingstatechange', () => log.debug(`signaling ${pc.signalingState}`));
  pc.addEventListener('icegatheringstatechange', () => log.debug(`gathering ${pc.iceGatheringState}`));
  pc.addEventListener('icecandidateerror', (e) => log.warn(`ice candidate error code=${e?.errorCode ?? '?'}`));
}

export function createControllerPeer({ sendSignal, iceServers = [], onTrack, onControl, onConnectionState, log = noopLog() }) {
  const pc = new RTCPeerConnection({ iceServers });
  attachPeerLogging(pc, log);
  const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
  preferVideoCodecs(videoTransceiver);
  // Input rides an unreliable + unordered channel: a dropped packet must never
  // stall the cursor (global constraint).
  const inputChannel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  inputChannel.addEventListener('open', () => log.info(`datachannel open label=${inputChannel.label}`));
  // Control (monitor list/switch, session end) rides a reliable, ordered channel
  // — these messages must not be dropped or reordered.
  const controlChannel = pc.createDataChannel('control', { ordered: true });
  controlChannel.addEventListener('open', () => log.info(`datachannel open label=${controlChannel.label}`));
  // Connect-from-console (SP2 §4.4): reliable, ordered channel carrying ONLY the
  // E2E device-keypair handshake (see shared/connection-auth.js). Created for every
  // session; used only on the linked (password-free) path.
  const authChannel = pc.createDataChannel('auth', { ordered: true });
  authChannel.addEventListener('open', () => log.info(`datachannel open label=${authChannel.label}`));
  controlChannel.addEventListener('open', () => {
    // Ask the host to enumerate its monitors as soon as the channel is ready.
    controlChannel.send(JSON.stringify({ type: CONTROL.LIST_MONITORS }));
  });
  controlChannel.addEventListener('message', (m) => {
    // R-7 (defense in depth): bound the payload before parsing so a hostile
    // host cannot send a huge string to the JSON parser. 256 KB, not 8 KB,
    // because CLIPBOARD frames carry up to 100000 chars of validated text and
    // need headroom for JSON-string escaping around that payload.
    if (typeof m.data === 'string' && m.data.length > 262144) return;
    let evt; try { evt = validateControlEvent(JSON.parse(m.data)); } catch { return; }
    if (onControl) onControl(evt);
  });
  pc.addEventListener('track', (e) => onTrack(e.streams[0]));
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) sendSignal(MSG.CANDIDATE, { candidate: e.candidate });
  });
  // Surface connection state, and on a drop that PERSISTS attempt a single
  // ICE restart (re-gather candidates, possibly via TURN) before giving up.
  // P-6: debounced — WebRTC flaps disconnected->connected under transient
  // loss, and restarting on every flap thrashes a recoverable link.
  let iceRestartTimer = null;
  const clearIceRestart = () => { if (iceRestartTimer) { clearTimeout(iceRestartTimer); iceRestartTimer = null; } };
  pc.addEventListener('connectionstatechange', () => {
    if (onConnectionState) onConnectionState(pc.connectionState);
    const recoverable = (s) => s === 'disconnected' || s === 'failed';
    if (recoverable(pc.connectionState)) {
      if (!iceRestartTimer) {
        iceRestartTimer = setTimeout(async () => {
          iceRestartTimer = null;
          if (!recoverable(pc.connectionState)) return; // recovered during the grace window
          try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            sendSignal(MSG.OFFER, { sdp: offer.sdp });
          } catch {}
        }, 2500);
      }
    } else {
      clearIceRestart();
    }
  });

  return {
    async start() {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(MSG.OFFER, { sdp: offer.sdp });
    },
    async handleAnswer(sdp) { await pc.setRemoteDescription({ type: 'answer', sdp }); },
    async handleCandidate(c) { try { await pc.addIceCandidate(c); } catch {} },
    sendInput(evt) { if (inputChannel.readyState === 'open') inputChannel.send(JSON.stringify(evt)); },
    sendControl(evt) { if (controlChannel.readyState === 'open') controlChannel.send(JSON.stringify(evt)); },
    getStats: () => pc.getStats(),
    // Connect-from-console: the 'auth' channel + the DTLS fingerprints (from the
    // exchanged SDP) the handshake binds to. Available after handleAnswer().
    authChannel,
    getFingerprints: () => ({
      local: parseDtlsFingerprint(pc.localDescription?.sdp || ''),
      remote: parseDtlsFingerprint(pc.remoteDescription?.sdp || ''),
    }),
    close: () => { clearIceRestart(); pc.close(); },
  };
}
