// packages/controller/test/host-peer.test.js
// The host has no peer.test.js to port (per task-4-brief.md), so this is a minimal
// export/shape guard for the ported answering-side peer: createHostPeer must be a
// function, and the object it returns (given a stub RTCPeerConnection) must expose
// the answering-side surface the controller's shell renderer relies on.
import { expect, test, beforeEach } from 'vitest';
import { createHostPeer } from '../src/host-peer.js';

// Minimal RTCDataChannel stub — just enough for open/close listeners + send().
class FakeChannel extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.readyState = 'open';
  }
  send() {}
  close() {}
}

// Minimal RTCPeerConnection stub: the HOST answers (receives an offer, creates an
// answer) and ADDS its own outgoing tracks — unlike the controller's stub, no
// createDataChannel()/addTransceiver() is needed since the host never initiates
// either; it reacts to 'datachannel' events and reads getTransceivers().
let lastPc;
class FakePC extends EventTarget {
  constructor() {
    super();
    lastPc = this;
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
  }
  addTrack() { return { getParameters: () => ({}), setParameters: () => {} }; }
  getTransceivers() { return []; }
  async getStats() { return new Map(); }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async setLocalDescription(desc) { this.localDescription = desc; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
  async addIceCandidate() {}
  close() {}
}

beforeEach(() => {
  global.RTCPeerConnection = FakePC;
  global.RTCRtpReceiver = { getCapabilities: () => null };
  global.RTCRtpSender = { getCapabilities: () => null };
});

function makeStream() {
  return { getTracks: () => [] };
}

test('createHostPeer is a function', () => {
  expect(typeof createHostPeer).toBe('function');
});

test('exposes the answering-side surface: handleOffer/handleCandidate/replaceVideoTrack/sendControl/getFingerprints/close', () => {
  const peer = createHostPeer({ stream: makeStream(), sendSignal: () => {} });
  expect(typeof peer.handleOffer).toBe('function');
  expect(typeof peer.handleCandidate).toBe('function');
  expect(typeof peer.replaceVideoTrack).toBe('function');
  expect(typeof peer.sendControl).toBe('function');
  expect(typeof peer.getFingerprints).toBe('function');
  expect(typeof peer.close).toBe('function');
});

test('handleOffer sets remote/local descriptions and sends an ANSWER', async () => {
  const sent = [];
  const peer = createHostPeer({ stream: makeStream(), sendSignal: (type, payload) => sent.push({ type, payload }) });
  await peer.handleOffer('v=0\r\n');
  expect(lastPc.remoteDescription).toEqual({ type: 'offer', sdp: 'v=0\r\n' });
  expect(lastPc.localDescription).toEqual({ type: 'answer', sdp: 'v=0\r\n' });
  expect(sent).toHaveLength(1);
  expect(sent[0].payload.sdp).toBe('v=0\r\n');
});

test('getFingerprints reflects local/remote descriptions after handleOffer', async () => {
  const peer = createHostPeer({ stream: makeStream(), sendSignal: () => {} });
  await peer.handleOffer('v=0\r\n');
  const fp = peer.getFingerprints();
  expect(fp).toHaveProperty('local');
  expect(fp).toHaveProperty('remote');
});

test('routes a datachannel labeled "auth" to onAuthChannel, not onInput/onControl', () => {
  const onAuthChannel = (ch) => { seen = ch; };
  let seen = null;
  createHostPeer({ stream: makeStream(), sendSignal: () => {}, onAuthChannel });
  const ch = new FakeChannel('auth');
  lastPc.dispatchEvent(Object.assign(new Event('datachannel'), { channel: ch }));
  expect(seen).toBe(ch);
});
