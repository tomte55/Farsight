import { expect, test } from 'vitest';
import {
  createRateEstimator, etaSeconds, bytesDone, filesDone, formatBytes, formatRate, formatDuration,
} from '../src/transfer-rate.js';

test('rate estimator needs two samples before it reports a rate', () => {
  let t = 0;
  const est = createRateEstimator({ now: () => t });
  expect(est.sample(0)).toBeNull(); // one sample is not a rate
  expect(est.rate()).toBeNull();
  t = 1000;
  expect(est.sample(1_000_000)).toBeCloseTo(1_000_000); // 1 MB in 1s
});

test('rate estimator averages over a rolling window and drops stale samples', () => {
  let t = 0;
  const est = createRateEstimator({ windowMs: 5000, now: () => t });
  est.sample(0);
  // A fast burst, then a slow stretch. Once the burst falls out of the 5s
  // window the reported rate reflects only the recent (slow) samples.
  t = 1000; est.sample(10_000_000);   // 10 MB/s burst
  t = 7000; est.sample(11_000_000);   // 6s later, only 1 MB more
  // Window keeps samples newer than t-5000 (i.e. >2000) plus the anchor: 1MB over 6s.
  const r = est.rate();
  expect(r).toBeGreaterThan(0);
  expect(r).toBeLessThan(10_000_000); // the burst no longer dominates
});

test('rate estimator resets when the cumulative count goes backwards (a resumed job)', () => {
  let t = 0;
  const est = createRateEstimator({ now: () => t });
  est.sample(5_000_000);
  t = 1000; est.sample(6_000_000);
  expect(est.rate()).not.toBeNull();
  t = 2000;
  expect(est.sample(0)).toBeNull(); // restarted → old window is meaningless, drop it
  expect(est.rate()).toBeNull();
});

test('rate estimator ignores a zero/negative time delta', () => {
  const est = createRateEstimator({ now: () => 500 }); // clock never advances
  est.sample(0);
  expect(est.sample(1_000_000)).toBeNull(); // dt = 0 → no rate, no divide-by-zero
});

test('reset clears the window', () => {
  let t = 0;
  const est = createRateEstimator({ now: () => t });
  est.sample(0); t = 1000; est.sample(1_000_000);
  expect(est.rate()).not.toBeNull();
  est.reset();
  expect(est.rate()).toBeNull();
});

test('etaSeconds divides remaining by rate, and is null when unknowable', () => {
  expect(etaSeconds(1_000_000, 1_000_000)).toBe(1);
  expect(etaSeconds(0, 1_000_000)).toBe(0);
  expect(etaSeconds(1_000_000, null)).toBeNull(); // no rate yet
  expect(etaSeconds(1_000_000, 0)).toBeNull();    // stalled → ETA is not "Infinity"
  expect(etaSeconds(null, 1_000_000)).toBeNull();
});

test('bytesDone normalizes the receiver {received} and sender {sent} shapes', () => {
  expect(bytesDone({ received: 42, total: 100 })).toBe(42);
  expect(bytesDone({ sent: 17, total: 100 })).toBe(17);
  expect(bytesDone(null)).toBe(0);
  expect(bytesDone({})).toBe(0);
});

test('filesDone normalizes the receiver {filesDone} and sender {filesSent} shapes', () => {
  // The transfer panel showed "0 / N files" for the ENTIRE receive because it
  // read the sender's field (filesSent) on a receive whose progress only has
  // filesDone. One normalizer, mirroring bytesDone, so both directions count.
  expect(filesDone({ filesSent: 3, filesTotal: 10 })).toBe(3);   // sender shape
  expect(filesDone({ filesDone: 7, filesTotal: 10 })).toBe(7);   // receiver shape
  expect(filesDone({ filesDone: 0, filesTotal: 10 })).toBe(0);   // a real 0, not a fallback
  expect(filesDone(null)).toBe(0);
  expect(filesDone({})).toBe(0);
});

test('formatBytes uses binary units with the familiar labels', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(1024 ** 3 * 1.5)).toBe('1.5 GB');
  expect(formatBytes(1024 ** 4 * 2)).toBe('2.0 TB');
  expect(formatBytes(-5)).toBe('0 B'); // defensive
});

test('formatRate appends /s and formatDuration is coarse and human', () => {
  expect(formatRate(1024 * 1024 * 12)).toBe('12.0 MB/s');
  expect(formatDuration(45)).toBe('45s');
  expect(formatDuration(90)).toBe('1m 30s');
  expect(formatDuration(3661)).toBe('1h 1m');
  expect(formatDuration(0)).toBe('0s');
});
