// Global send-rate limiter (virtual-clock / leaky-bucket pacer). bytesPerSec <= 0 = unlimited.
// Clock (now/sleep) injected so pacing is deterministically testable.
// Each take(n) reserves n/rate seconds of "pipe time" starting at the earliest free instant.
// This paces ANY n correctly -- including a single chunk whose byte count exceeds one
// second's byte budget (n > rate) -- with no deadlock and no capacity cap.
export function createRateLimiter(bytesPerSec, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  let rate = bytesPerSec > 0 ? bytesPerSec : 0;
  let nextAt = now(); // earliest time the next byte may go on the wire
  return {
    rate() { return rate; },
    setRate(bps) { rate = bps > 0 ? bps : 0; nextAt = now(); }, // reset backlog on retune
    async take(n) {
      if (rate <= 0) return; // unlimited
      const t = now();
      if (nextAt < t) nextAt = t; // idle catch-up (no unbounded burst banking)
      const sendAt = nextAt;
      nextAt += (n / rate) * 1000; // this send occupies n/rate seconds of pipe
      const wait = sendAt - t;
      if (wait > 0) await sleep(wait);
    },
  };
}
