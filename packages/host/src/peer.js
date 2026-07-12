// packages/host/src/peer.js
import { MSG } from '@farsight/shared/protocol';

export function createHostPeer({ stream, sendSignal, iceServers = [], onInput = () => {}, onControl = () => {} }) {
  const pc = new RTCPeerConnection({ iceServers });
  let videoSender = null;
  for (const track of stream.getTracks()) videoSender = pc.addTrack(track, stream);

  let hostControlChannel = null;
  pc.addEventListener('datachannel', (e) => {
    const ch = e.channel;
    ch.addEventListener('message', (m) => {
      // R-7 (defense in depth): bound the payload before parsing so a hostile
      // controller cannot send a huge string to the JSON parser.
      if (typeof m.data === 'string' && m.data.length > 8192) return;
      let parsed; try { parsed = JSON.parse(m.data); } catch { return; }
      if (ch.label === 'input') onInput(parsed);
      else if (ch.label === 'control') onControl(parsed);
    });
    if (ch.label === 'control') hostControlChannel = ch;
  });

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) sendSignal(MSG.CANDIDATE, { candidate: e.candidate });
  });

  return {
    async handleOffer(sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(MSG.ANSWER, { sdp: answer.sdp });
    },
    async handleCandidate(candidate) { try { await pc.addIceCandidate(candidate); } catch {} },
    // Swap the streamed video track when the controller selects another monitor,
    // without renegotiating the peer connection.
    async replaceVideoTrack(track) { if (videoSender) await videoSender.replaceTrack(track); },
    sendControl(evt) {
      if (hostControlChannel && hostControlChannel.readyState === 'open') hostControlChannel.send(JSON.stringify(evt));
    },
    close: () => pc.close(),
  };
}
