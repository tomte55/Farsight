import { test, expect } from 'vitest';
import { flowLaneSpec, deckModel } from '../src/transfer-deck.js';

test('flowLaneSpec: 14 of 16 flows live → 14 healthy, 2 dead, in order', () => {
  const lanes = flowLaneSpec({ flowsTotal: 16, flowsLive: 14 });
  expect(lanes).toHaveLength(16);
  expect(lanes.filter((l) => l.state === 'healthy')).toHaveLength(14);
  expect(lanes.filter((l) => l.state === 'dead')).toHaveLength(2);
  expect(lanes[0].state).toBe('healthy');
  expect(lanes[15].state).toBe('dead');
});

test('flowLaneSpec: single-flow and missing data yield no lanes', () => {
  expect(flowLaneSpec({ flowsTotal: 1, flowsLive: 1 })).toEqual([]);
  expect(flowLaneSpec({})).toEqual([]);
  expect(flowLaneSpec(undefined)).toEqual([]);
});

test('flowLaneSpec: clamps flowsLive to [0, total]', () => {
  expect(flowLaneSpec({ flowsTotal: 4, flowsLive: 9 }).every((l) => l.state === 'healthy')).toBe(true);
  expect(flowLaneSpec({ flowsTotal: 4, flowsLive: -3 }).every((l) => l.state === 'dead')).toBe(true);
});

const activeSend = {
  direction: 'send',
  state: 'active',
  createdAt: 1000,
  rate: 24_000_000, // 24 MB/s
  progress: { sent: 28_400_000_000, total: 60_300_000_000, filesSent: 9, filesTotal: 22, flowsTotal: 16, flowsLive: 14, redials: 3 },
};

test('deckModel: derives display strings from an active multi-flow send', () => {
  const m = deckModel(activeSend, { now: 1000 + 19 * 60 * 1000, peakRate: 31_200_000 });
  expect(m.arrow).toBe('↑');
  expect(m.statePill).toBe('Transferring');
  expect(m.rateText).toMatch(/MB\/s/);
  expect(m.peakText).toMatch(/MB\/s/);
  expect(m.fraction).toBeCloseTo(28_400_000_000 / 60_300_000_000, 5);
  expect(m.transferredText).toMatch(/GB/);
  expect(m.filesText).toBe('9 / 22');
  expect(m.etaText).toMatch(/^~/);          // has an ETA while active
  expect(m.elapsedText).toBe('19m 0s');     // 19 minutes since createdAt
  expect(m.flowText).toMatch(/14\/16 flows/);
  expect(m.lanes).toHaveLength(16);
});

test('deckModel: receive with no rate has no ETA/peak, arrow flips', () => {
  const m = deckModel({ direction: 'recv', state: 'active', createdAt: 0, progress: { received: 100, total: 340, filesTotal: 6 } }, { now: 0 });
  expect(m.arrow).toBe('↓');
  expect(m.etaText).toBe('');
  expect(m.peakText).toBe('');
  expect(m.lanes).toEqual([]);              // single/no-flow → no equalizer
});
