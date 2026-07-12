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
  };
}
