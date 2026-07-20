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
  let generation = 0;   // bumped by invalidate() so a stale in-flight write is discarded

  return {
    get(fetchFn) {
      if (entry && (now() - entry.at) < ttlMs) return Promise.resolve(entry.value);
      if (inflight) return inflight;                     // COALESCE concurrent callers
      const gen = generation;                             // capture BEFORE the fetch starts
      const p = (async () => {
        const value = await fetchFn();
        // Only seat the result if invalidate() hasn't run since this fetch started —
        // otherwise a fetch in flight at invalidation time would re-populate the
        // cache with a stale value AFTER the invalidation (fail-open).
        if (gen === generation) entry = shouldCache(value) ? { value, at: now() } : null;
        return value;
      })();
      inflight = p;
      // Clear the in-flight marker on settle (success OR failure) so a rejected
      // fetch caches nothing and the next call retries.
      p.then(() => { if (inflight === p) inflight = null; }, () => { if (inflight === p) inflight = null; });
      return p;
    },
    invalidate() { entry = null; inflight = null; generation++; },
  };
}
