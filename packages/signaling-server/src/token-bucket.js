// packages/signaling-server/src/token-bucket.js
// L-2: per-socket message rate limit. Classic token bucket — refills
// continuously based on elapsed wall-clock time, so short bursts (e.g. a
// flurry of ICE candidates) are absorbed while sustained flooding is capped.
export function createTokenBucket({ capacity = 60, refillPerSec = 30, now = () => Date.now() } = {}) {
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
