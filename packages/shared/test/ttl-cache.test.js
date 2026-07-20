import { describe, it, expect } from 'vitest';
import { createTtlCache } from '../src/ttl-cache.js';

describe('createTtlCache', () => {
  it('coalesces concurrent in-flight calls into ONE fetch', async () => {
    let now = 0;
    let calls = 0;
    let resolveFetch;
    const fetchFn = () => { calls += 1; return new Promise((r) => { resolveFetch = r; }); };
    const cache = createTtlCache({ now: () => now, ttlMs: 1000 });
    const a = cache.get(fetchFn);
    const b = cache.get(fetchFn);
    const c = cache.get(fetchFn);        // three concurrent callers, fetch still in flight
    expect(calls).toBe(1);               // only ONE fetch started
    resolveFetch('V');
    expect(await a).toBe('V');
    expect(await b).toBe('V');
    expect(await c).toBe('V');           // all three get the shared result
  });

  it('serves a cached value within TTL without re-fetching', async () => {
    let now = 0; let calls = 0;
    const cache = createTtlCache({ now: () => now, ttlMs: 1000 });
    const f = () => { calls += 1; return Promise.resolve('V'); };
    expect(await cache.get(f)).toBe('V');
    now = 999;
    expect(await cache.get(f)).toBe('V');
    expect(calls).toBe(1);               // second call within TTL: no fetch
  });

  it('re-fetches after TTL expiry', async () => {
    let now = 0; let calls = 0;
    const cache = createTtlCache({ now: () => now, ttlMs: 1000 });
    const f = () => { calls += 1; return Promise.resolve('V'); };
    await cache.get(f);
    now = 1000;                          // exactly at TTL boundary → expired
    await cache.get(f);
    expect(calls).toBe(2);
  });

  it('does NOT cache a value that fails shouldCache (fail-closed)', async () => {
    let now = 0; let calls = 0;
    const cache = createTtlCache({ now: () => now, ttlMs: 1000, shouldCache: (v) => v && v.ok === true });
    const f = () => { calls += 1; return Promise.resolve({ ok: false }); };
    expect(await cache.get(f)).toEqual({ ok: false });
    expect(await cache.get(f)).toEqual({ ok: false });
    expect(calls).toBe(2);               // the not-ok result was never cached
  });

  it('does NOT cache a rejected fetch and propagates it', async () => {
    let now = 0; let calls = 0;
    const cache = createTtlCache({ now: () => now, ttlMs: 1000 });
    const f = () => { calls += 1; return Promise.reject(new Error('boom')); };
    await expect(cache.get(f)).rejects.toThrow('boom');
    await expect(cache.get(f)).rejects.toThrow('boom');
    expect(calls).toBe(2);               // retried, nothing cached
  });

  it('invalidate() forces a re-fetch even within TTL', async () => {
    let now = 0; let calls = 0;
    const cache = createTtlCache({ now: () => now, ttlMs: 1000 });
    const f = () => { calls += 1; return Promise.resolve('V'); };
    await cache.get(f);
    cache.invalidate();
    await cache.get(f);
    expect(calls).toBe(2);
  });
});
