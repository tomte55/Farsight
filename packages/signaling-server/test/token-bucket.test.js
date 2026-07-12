// packages/signaling-server/test/token-bucket.test.js
import { expect, test } from 'vitest';
import { createTokenBucket } from '../src/token-bucket.js';

// L-2: per-socket message rate limit — a classic token bucket, generous
// enough that normal ICE-candidate bursts sail through.
test('starts full: capacity tokens are immediately available', () => {
  const tb = createTokenBucket({ capacity: 3, refillPerSec: 1, now: () => 0 });
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(true);
});

test('depletes: returns false once tokens run out', () => {
  const tb = createTokenBucket({ capacity: 2, refillPerSec: 1, now: () => 0 });
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(false); // exhausted
});

test('refills over time based on elapsed seconds', () => {
  let t = 0;
  const tb = createTokenBucket({ capacity: 2, refillPerSec: 1, now: () => t });
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(false); // empty at t=0

  t = 1000; // 1 second later -> +1 token
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(false); // only one token refilled
});

test('never exceeds capacity even after a long idle period', () => {
  let t = 0;
  const tb = createTokenBucket({ capacity: 2, refillPerSec: 1, now: () => t });
  tb.tryRemove(); tb.tryRemove(); // drain to 0

  t = 1_000_000; // huge elapsed time
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(false); // still capped at capacity=2, not unbounded
});

test('tryRemove(n) removes multiple tokens atomically — fails without partial deduction', () => {
  const tb = createTokenBucket({ capacity: 5, refillPerSec: 1, now: () => 0 });
  expect(tb.tryRemove(3)).toBe(true);
  expect(tb.tryRemove(3)).toBe(false); // only 2 left, insufficient for 3
  expect(tb.tryRemove(2)).toBe(true); // the failed attempt above didn't deduct
});

test('defaults tryRemove to removing 1 token', () => {
  const tb = createTokenBucket({ capacity: 1, refillPerSec: 1, now: () => 0 });
  expect(tb.tryRemove()).toBe(true);
  expect(tb.tryRemove()).toBe(false);
});
