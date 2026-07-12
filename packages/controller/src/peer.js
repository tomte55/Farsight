// packages/controller/src/peer.js
import { MSG } from '@farsight/shared/protocol';
import { CONTROL, validateControlEvent } from '@farsight/shared/control-events';

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

export function createControllerPeer({ sendSignal, iceServers = [], onTrack, onControl, onConnectionState }) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.addTransceiver('video', { direction: 'recvonly' });
  // Input rides an unreliable + unordered channel: a dropped packet must never
  // stall the cursor (global constraint).
  const inputChannel = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  // Control (monitor list/switch, session end) rides a reliable, ordered channel
  // — these messages must not be dropped or reordered.
  const controlChannel = pc.createDataChannel('control', { ordered: true });
  controlChannel.addEventListener('open', () => {
    // Ask the host to enumerate its monitors as soon as the channel is ready.
    controlChannel.send(JSON.stringify({ type: CONTROL.LIST_MONITORS }));
  });
  controlChannel.addEventListener('message', (m) => {
    if (typeof m.data === 'string' && m.data.length > 8192) return;
    let evt; try { evt = validateControlEvent(JSON.parse(m.data)); } catch { return; }
    if (onControl) onControl(evt);
  });
  pc.addEventListener('track', (e) => onTrack(e.streams[0]));
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) sendSignal(MSG.CANDIDATE, { candidate: e.candidate });
  });
  // Surface connection state, and on a transient drop attempt a single ICE
  // restart (re-gather candidates, possibly via TURN) before giving up.
  pc.addEventListener('connectionstatechange', async () => {
    if (onConnectionState) onConnectionState(pc.connectionState);
    if (pc.connectionState === 'disconnected') {
      try {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        sendSignal(MSG.OFFER, { sdp: offer.sdp });
      } catch {}
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
    close: () => pc.close(),
  };
}
