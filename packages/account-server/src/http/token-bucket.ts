// Per-IP request rate limit — a classic token bucket ported from the signaling
// server (src/token-bucket.js) to TS. Refills continuously by elapsed wall
// time, so short bursts are absorbed while sustained flooding is capped.

export interface TokenBucket {
  tryRemove(n?: number): boolean;
}

export function createTokenBucket({
  capacity = 60,
  refillPerSec = 30,
  now = () => Date.now(),
}: { capacity?: number; refillPerSec?: number; now?: () => number } = {}): TokenBucket {
  let tokens = capacity;
  let last = now();

  const refill = () => {
    const t = now();
    const elapsedSec = Math.max(0, t - last) / 1000;
    if (elapsedSec > 0) {
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      last = t;
    }
  };

  return {
    tryRemove(n = 1) {
      refill();
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}
