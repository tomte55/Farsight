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

test('setRate switches to unlimited', async () => {
  const sleep = vi.fn(() => Promise.resolve());
  const rl = createRateLimiter(1000, { now: () => 0, sleep });
  await rl.take(1000);
  rl.setRate(0);
  await rl.take(10_000_000); // now unlimited
  expect(sleep).not.toHaveBeenCalled();
  expect(rl.rate()).toBe(0);
});
