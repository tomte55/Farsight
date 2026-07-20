// packages/shared/src/ttl-cache.js
// A tiny single-slot cache with a TTL and IN-FLIGHT COALESCING: concurrent
// callers during a pending fetch share the one fetch (no thundering herd), and
// a resolved value is cached for ttlMs iff shouldCache(value). Runtime-agnostic:
// the clock is injected. Used to collapse the per-flow fleet/contacts
// classification amplification (Phase 3b-2) without weakening any verification —
// it only makes a lookup answer faster, never changes the answer.
export function createTtlCache({ now = () => Date.now(), ttlMs, shouldCache = () => true } = {}) {
  let entry = null;     // { value, at }
  let inflight = null;  // Promise<value> while a fetch is pending

  return {
    get(fetchFn) {
      if (entry && (now() - entry.at) < ttlMs) return Promise.resolve(entry.value);
      if (inflight) return inflight;                     // COALESCE concurrent callers
      const p = (async () => {
        const value = await fetchFn();
        entry = shouldCache(value) ? { value, at: now() } : null; // fail-closed: don't cache non-ok
        return value;
      })();
      inflight = p;
      // Clear the in-flight marker on settle (success OR failure) so a rejected
      // fetch caches nothing and the next call retries.
      p.then(() => { if (inflight === p) inflight = null; }, () => { if (inflight === p) inflight = null; });
      return p;
    },
    invalidate() { entry = null; inflight = null; },
  };
}
