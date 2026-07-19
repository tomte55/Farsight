import { test, expect } from 'vitest';
import { pushSample, waveformPath } from '../src/transfer-samples.js';

test('pushSample appends, clamps negative rate, prunes old, caps length', () => {
  let s = [];
  s = pushSample(s, 1000, 5, { maxAgeMs: 5000, maxLen: 100 });
  s = pushSample(s, 2000, -3, { maxAgeMs: 5000, maxLen: 100 }); // clamps to 0
  expect(s.map((x) => x.rate)).toEqual([5, 0]);
  s = pushSample(s, 9000, 7, { maxAgeMs: 5000, maxLen: 100 }); // prunes t=1000,2000 (age>5000)
  expect(s).toEqual([{ t: 9000, rate: 7 }]);
});

test('pushSample caps to maxLen keeping the newest', () => {
  let s = [];
  for (let i = 0; i < 10; i += 1) s = pushSample(s, i, i, { maxAgeMs: 1e9, maxLen: 3 });
  expect(s.map((x) => x.rate)).toEqual([7, 8, 9]);
});

test('waveformPath: empty → empty; scales to the box and peak', () => {
  expect(waveformPath([], 100, 50)).toEqual({ line: '', area: '', max: 0 });
  const r = waveformPath([{ t: 0, rate: 0 }, { t: 10, rate: 100 }], 100, 50, { pad: 0 });
  expect(r.max).toBe(100);
  expect(r.line.startsWith('M')).toBe(true);
  // first point at x=0 y=h (rate 0 → bottom), last at x=w y=0 (peak → top)
  expect(r.line).toContain('0.0,50.0');
  expect(r.line).toContain('100.0,0.0');
  expect(r.area.endsWith('Z')).toBe(true);
});
