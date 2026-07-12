// packages/host/src/peer.js
import { MSG } from '@farsight/shared/protocol';
import { CHUNK_SIZE } from '@farsight/shared/file-transfer';

// P-1: protect resolution/text legibility under bandwidth pressure (screen
// content), rather than Chromium's default 'balanced' which drops resolution
// first. Fire-and-forget, fully guarded — must never throw into the caller.
async function tuneVideoSender(sender) {
  if (!sender || !sender.getParameters) return;
  try {
    const params = sender.getParameters();
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch { /* API unavailable — leave defaults */ }
}

// P-3: prefer VP8 then H264 (broad hardware-encoder coverage, low encode
// latency) by REORDERING (never excluding) the codec list on the video
// transceiver.
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

export function createHostPeer({ stream, sendSignal, iceServers = [], onInput = () => {}, onControl = () => {}, onFileMessage = () => {} }) {
  const pc = new RTCPeerConnection({ iceServers });
  let videoSender = null;
  for (const track of stream.getTracks()) {
    if (track.kind === 'video') { try { track.contentHint = 'detail'; } catch {} }
    videoSender = pc.addTrack(track, stream);
  }
  tuneVideoSender(videoSender);
  try {
    const vtx = pc.getTransceivers().find((t) => t.sender === videoSender);
    if (vtx) preferVideoCodecs(vtx);
  } catch { /* leave default negotiation */ }

  let hostControlChannel = null;
  let hostFileChannel = null;
  pc.addEventListener('datachannel', (e) => {
    const ch = e.channel;
    if (ch.label === 'file') {
      try { ch.binaryType = 'arraybuffer'; } catch { /* guarded */ }
      hostFileChannel = ch;
      ch.onmessage = (m) => {
        try {
          if (typeof m.data === 'string') {
            // R-7 (defense in depth): bound framing strings before they reach
            // JSON parsing / the receiver state machine.
            if (m.data.length > 8192) return;
            onFileMessage(m.data);
          } else {
            // Binary chunk: bound well above CHUNK_SIZE (in case of transient
            // renegotiation of chunk size) but drop anything wildly oversized.
            const len = m.data && m.data.byteLength;
            if (typeof len !== 'number' || len > CHUNK_SIZE * 2) return;
            onFileMessage(m.data);
          }
        } catch { /* never throw out of a data channel handler */ }
      };
      return;
    }
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
    async replaceVideoTrack(track) {
      if (!videoSender) return;
      if (track && track.kind === 'video') { try { track.contentHint = 'detail'; } catch {} }
      await videoSender.replaceTrack(track);
      tuneVideoSender(videoSender);
    },
    sendControl(evt) {
      if (hostControlChannel && hostControlChannel.readyState === 'open') hostControlChannel.send(JSON.stringify(evt));
    },
    // File transfer surface, mirroring the controller peer's. onFileMessage
    // is wired via the constructor callback above (the channel is created by
    // the controller and only exists once 'datachannel' fires), so it is not
    // re-exposed as a registration method here.
    sendFileData(data) {
      try { if (hostFileChannel && hostFileChannel.readyState === 'open') hostFileChannel.send(data); } catch { /* guarded */ }
    },
    fileBufferedAmount() { try { return hostFileChannel ? hostFileChannel.bufferedAmount : 0; } catch { return 0; } },
    onFileBufferedLow(cb) {
      try { if (hostFileChannel) hostFileChannel.onbufferedamountlow = () => { try { cb(); } catch { /* guarded */ } }; } catch { /* guarded */ }
    },
    close: () => pc.close(),
  };
}
