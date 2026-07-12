// packages/signaling-server/src/rate-limit.js
export function createRateLimiter({ maxAttempts = 5, windowMs = 60000, now = () => Date.now() } = {}) {
  const attempts = new Map(); // id -> [timestamps]

  const prune = (id) => {
    const cutoff = now() - windowMs;
    const list = (attempts.get(id) || []).filter((t) => t > cutoff);
    if (list.length) attempts.set(id, list); else attempts.delete(id);
    return list;
  };

  return {
    recordFailure(id) {
      const list = prune(id);
      list.push(now());
      attempts.set(id, list);
    },
    isLocked(id) { return prune(id).length >= maxAttempts; },
    reset(id) { attempts.delete(id); },
    // L-4: periodic GC — prune every key's expired timestamps (dropping keys
    // left empty) so long-running servers don't accumulate stale entries from
    // one-off attackers/probes that never come back to age out naturally.
    sweep() {
      for (const id of [...attempts.keys()]) prune(id);
    },
  };
}
