// Global send-rate limiter (token bucket). bytesPerSec <= 0 = unlimited.
// Clock (now/sleep) injected so pacing is deterministically testable.
export function createRateLimiter(bytesPerSec, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  let rate = bytesPerSec > 0 ? bytesPerSec : 0;
  let tokens = rate;
  let last = now();
  function refill() {
    const t = now();
    if (rate > 0) tokens = Math.min(rate, tokens + ((t - last) / 1000) * rate);
    last = t;
  }
  return {
    rate() { return rate; },
    setRate(bps) { rate = bps > 0 ? bps : 0; if (tokens > rate) tokens = rate; last = now(); },
    async take(n) {
      if (rate <= 0) return;
      for (;;) {
        refill();
        const avail = tokens;
        if (avail >= n || n > rate) { tokens = Math.max(0, avail - n); return; }
        const deficit = n - avail;
        await sleep(Math.max(1, Math.ceil((deficit / rate) * 1000)));
      }
    },
  };
}
