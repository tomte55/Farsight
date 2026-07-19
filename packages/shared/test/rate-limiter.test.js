import { test, expect, vi } from 'vitest';
import { createRateLimiter } from '../src/rate-limiter.js';

test('rate<=0 is unlimited: take never sleeps', async () => {
  const sleep = vi.fn(() => Promise.resolve());
  const rl = createRateLimiter(0, { now: () => 0, sleep });
  await rl.take(1_000_000);
  expect(sleep).not.toHaveBeenCalled();
});

test('take waits when the bucket lacks tokens, then proceeds as the clock advances', async () => {
  let t = 0;
  const sleep = vi.fn((ms) => { t += ms; return Promise.resolve(); }); // advancing the clock during sleep
  const rl = createRateLimiter(1000, { now: () => t, sleep }); // 1000 B/s, bucket starts full=1000
  await rl.take(1000);            // drains the full bucket, no sleep
  expect(sleep).not.toHaveBeenCalled();
  await rl.take(500);            // bucket empty → must sleep ~500ms worth
  expect(sleep).toHaveBeenCalled();
  expect(t).toBeGreaterThanOrEqual(500);
});

test('take paces even when a single chunk exceeds the per-second rate (oversized chunk, e.g. 1 Mbps floor)', async () => {
  let t = 0;
  const sleep = vi.fn((ms) => { t += ms; return Promise.resolve(); }); // advancing the clock during sleep
  const rate = 125000; // 1 Mbps, the minimum selectable rate
  const rl = createRateLimiter(rate, { now: () => t, sleep });
  const n = 131072; // production chunk size, exceeds one second's byte budget (n > rate)
  const chunks = 5;
  for (let i = 0; i < chunks; i++) {
    await rl.take(n);
  }
  const perChunkMs = (n / rate) * 1000; // ~1048.576ms of pipe time per chunk
  // First chunk may pass immediately (empty backlog); every subsequent chunk must pace ~perChunkMs.
  expect(t).toBeGreaterThanOrEqual(perChunkMs * (chunks - 1) - 1);
  expect(t).toBeLessThanOrEqual(perChunkMs * chunks + 1);
});

test('setRate switches to unlimited', async () => {
  const sleep = vi.fn(() => Promise.resolve());
  const rl = createRateLimiter(1000, { now: () => 0, sleep });
  await rl.take(1000);
  rl.setRate(0);
  await rl.take(10_000_000); // now unlimited
  expect(sleep).not.toHaveBeenCalled();
  expect(rl.rate()).toBe(0);
});
