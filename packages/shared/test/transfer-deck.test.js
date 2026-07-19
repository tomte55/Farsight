import { test, expect } from 'vitest';
import { flowLaneSpec } from '../src/transfer-deck.js';

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
