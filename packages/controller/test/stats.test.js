// packages/controller/test/stats.test.js
import { expect, test } from 'vitest';
import { extractStats, throughputKbps, formatQuality } from '../src/stats.js';

function report(entries) {
  return new Map(entries.map((e) => [e.id, e]));
}

test('extractStats picks the nominated candidate-pair RTT and direct transport', () => {
  const r = report([
    { id: 'cp1', type: 'candidate-pair', nominated: false, currentRoundTripTime: 0.5, localCandidateId: 'l1' },
    { id: 'cp2', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.034, localCandidateId: 'l2' },
    { id: 'l1', type: 'local-candidate', candidateType: 'relay' },
    { id: 'l2', type: 'local-candidate', candidateType: 'srflx' },
    { id: 'ibrtp', type: 'inbound-rtp', kind: 'video', bytesReceived: 12345, timestamp: 1000, frameWidth: 1920, frameHeight: 1080 },
  ]);
  const s = extractStats(r);
  expect(s.rttMs).toBe(34);
  expect(s.bytes).toBe(12345);
  expect(s.ts).toBe(1000);
  expect(s.width).toBe(1920);
  expect(s.height).toBe(1080);
  expect(s.transport).toBe('direct');
});

test('extractStats falls back to succeeded candidate-pair when none nominated', () => {
  const r = report([
    { id: 'cp1', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.1, localCandidateId: 'l1' },
    { id: 'l1', type: 'local-candidate', candidateType: 'host' },
  ]);
  const s = extractStats(r);
  expect(s.rttMs).toBe(100);
  expect(s.transport).toBe('direct');
});

test('extractStats detects relay transport', () => {
  const r = report([
    { id: 'cp1', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.02, localCandidateId: 'l1' },
    { id: 'l1', type: 'local-candidate', candidateType: 'relay' },
  ]);
  const s = extractStats(r);
  expect(s.transport).toBe('relay');
});

test('extractStats returns nulls when nothing is present', () => {
  const s = extractStats(report([]));
  expect(s).toEqual({ rttMs: null, bytes: null, ts: null, width: null, height: null, transport: null });
});

test('extractStats returns null transport when local candidate is missing', () => {
  const r = report([
    { id: 'cp1', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.02, localCandidateId: 'missing' },
  ]);
  const s = extractStats(r);
  expect(s.rttMs).toBe(20);
  expect(s.transport).toBeNull();
});

test('throughputKbps computes kbps from byte/time deltas', () => {
  const prev = { bytes: 1000, ts: 0 };
  const cur = { bytes: 1000 + 125000, ts: 1000 }; // 1,000,000 bits over 1000ms = 1000 kbps
  expect(throughputKbps(prev, cur)).toBe(1000);
});

test('throughputKbps returns null on non-positive time delta', () => {
  expect(throughputKbps({ bytes: 100, ts: 1000 }, { bytes: 200, ts: 1000 })).toBeNull();
  expect(throughputKbps({ bytes: 100, ts: 1000 }, { bytes: 200, ts: 500 })).toBeNull();
});

test('throughputKbps returns null when a sample lacks bytes or ts', () => {
  expect(throughputKbps({ bytes: null, ts: 0 }, { bytes: 200, ts: 1000 })).toBeNull();
  expect(throughputKbps({ bytes: 100, ts: null }, { bytes: 200, ts: 1000 })).toBeNull();
  expect(throughputKbps({ bytes: 100, ts: 0 }, { bytes: null, ts: 1000 })).toBeNull();
});

test('formatQuality joins present fields with middle dots', () => {
  expect(formatQuality({ rttMs: 34, kbps: 3200, width: 1920, height: 1080, transport: 'direct' }))
    .toBe('34 ms · 3.2 Mbps · 1920×1080 · direct');
});

test('formatQuality shows kbps under 1000 as kbps', () => {
  expect(formatQuality({ rttMs: 12, kbps: 450, width: null, height: null, transport: 'relay' }))
    .toBe('12 ms · 450 kbps · relay');
});

test('formatQuality omits missing fields', () => {
  expect(formatQuality({ rttMs: null, kbps: null, width: null, height: null, transport: null })).toBe('—');
  expect(formatQuality({ rttMs: 20, kbps: null, width: null, height: null, transport: null })).toBe('20 ms');
});
