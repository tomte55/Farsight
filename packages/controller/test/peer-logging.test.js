// packages/controller/test/peer-logging.test.js
import { expect, test, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createControllerPeer } from '../src/peer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Minimal RTCPeerConnection stub: records the instance and lets tests fire
// events. The controller CREATES data channels and a video transceiver, so
// (unlike the host stub) this needs addTransceiver()/createDataChannel().
let lastPc;
class FakePC extends EventTarget {
  constructor() {
    super();
    lastPc = this;
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.iceGatheringState = 'new';
    this.localDescription = null; this.remoteDescription = null;
  }
  addTransceiver() { return { sender: {}, setCodecPreferences() {} }; }
  createDataChannel(label) { return new FakeChannel(label); }
  getTransceivers() { return []; }
  async getStats() { return new Map(); }
  close() {}
}

beforeEach(() => { global.RTCPeerConnection = FakePC; global.RTCRtpReceiver = { getCapabilities: () => null }; global.RTCRtpSender = { getCapabilities: () => null }; });

function makeLog() { const calls = []; const mk = () => ({ debug: (m) => calls.push(['debug', m]), info: (m) => calls.push(['info', m]), warn: (m) => calls.push(['warn', m]), error: (m) => calls.push(['error', m]), child: mk }); return { log: mk(), calls }; }

test('logs ice + connection state transitions at info', () => {
  const { log, calls } = makeLog();
  createControllerPeer({ sendSignal: () => {}, log });
  lastPc.iceConnectionState = 'connected';
  lastPc.dispatchEvent(new Event('iceconnectionstatechange'));
  lastPc.connectionState = 'connected';
  lastPc.dispatchEvent(new Event('connectionstatechange'));
  const text = calls.map((c) => c.join(' ')).join('\n');
  expect(text).toMatch(/info ice connected/);
  expect(text).toMatch(/info conn connected/);
});

test('never logs SDP or raw candidate strings', () => {
  const src = readFileSync(join(__dirname, '../src/peer.js'), 'utf8');
  expect(src).not.toMatch(/\.(info|debug|warn|error)\([^)]*\b(sdp|\.candidate)\b/);
});
