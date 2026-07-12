// packages/signaling-server/test/rate-limit.test.js
import { expect, test } from 'vitest';
import { createRateLimiter } from '../src/rate-limit.js';

// R-4: the limiter is keyed by a composite `targetId|sourceIp` string so a
// lockout is scoped to a (host, attacker-IP) pair, not the host globally.
const key = (id, ip) => `${id}|${ip}`;

test('locks after max attempts and unlocks after window', () => {
  let t = 1000;
  const rl = createRateLimiter({ maxAttempts: 3, windowMs: 500, now: () => t });
  const k = key('h', '1.2.3.4');
  rl.recordFailure(k); rl.recordFailure(k); expect(rl.isLocked(k)).toBe(false);
  rl.recordFailure(k); expect(rl.isLocked(k)).toBe(true);
  t = 1600; // past the window
  expect(rl.isLocked(k)).toBe(false);
});

test('lockout is scoped per composite key', () => {
  let t = 0;
  const rl = createRateLimiter({ maxAttempts: 2, windowMs: 1000, now: () => t });
  const a = key('h', '1.1.1.1');
  const b = key('h', '2.2.2.2');
  rl.recordFailure(a); rl.recordFailure(a);
  expect(rl.isLocked(a)).toBe(true);
  expect(rl.isLocked(b)).toBe(false); // a different source IP is unaffected
});

test('reset clears failures', () => {
  let t = 0;
  const rl = createRateLimiter({ maxAttempts: 2, windowMs: 1000, now: () => t });
  const k = key('h', '1.2.3.4');
  rl.recordFailure(k); rl.recordFailure(k); expect(rl.isLocked(k)).toBe(true);
  rl.reset(k); expect(rl.isLocked(k)).toBe(false);
});
