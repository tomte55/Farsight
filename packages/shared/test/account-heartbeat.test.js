// Client-side presence heartbeat (SP2 S2.5, Option D). A signed-in app tells the
// account server it's alive: periodically POST /devices/heartbeat with a fresh
// access token + the app version, so the owner's fleet console shows it online
// with its current version. The server's online window is 90s, so the interval
// is comfortably shorter. Pure — session, client, and scheduler injected.

import { describe, expect, test, vi } from 'vitest';
import { createHeartbeat } from '../src/account-heartbeat.js';

// A fake scheduler that captures the interval callback so a test can trigger
// ticks deterministically (no real timers). Mirrors the injected-clock pattern
// used by the session tests.
function fakeScheduler() {
  let cb = null;
  let handle = 0;
  return {
    setInterval: vi.fn((fn) => { cb = fn; return ++handle; }),
    clearInterval: vi.fn(() => { cb = null; }),
    tick: async () => { if (cb) await cb(); },
    hasCallback: () => cb !== null,
  };
}

function signedInSession(token = 'access-1') {
  return { getAccessToken: vi.fn().mockResolvedValue(token) };
}

describe('createHeartbeat', () => {
  test('start() sends an immediate heartbeat with the access token and version', async () => {
    const session = signedInSession('access-1');
    const client = { heartbeat: vi.fn().mockResolvedValue({ ok: true, status: 204 }) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.5.0', intervalMs: 30_000, setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await hb.start();

    expect(client.heartbeat).toHaveBeenCalledWith({ accessToken: 'access-1', version: '1.5.0' });
    expect(sched.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000);
  });

  test('includes the current signalingId from the injected getter (rendezvous)', async () => {
    const session = signedInSession('access-1');
    const client = { heartbeat: vi.fn().mockResolvedValue({ ok: true, status: 204 }) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.7.0', getSignalingId: () => '456789123', setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await hb.beat();

    expect(client.heartbeat).toHaveBeenCalledWith({ accessToken: 'access-1', version: '1.7.0', signalingId: '456789123' });
  });

  test('calls onDirective with the heartbeat response body (S2.7 remote update)', async () => {
    const session = signedInSession('access-1');
    const client = { heartbeat: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { targetVersion: '1.8.0' } }) };
    const sched = fakeScheduler();
    const seen = [];
    const hb = createHeartbeat({ session, client, version: '1.7.0', onDirective: (d) => seen.push(d), setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await hb.beat();

    expect(seen).toEqual([{ targetVersion: '1.8.0' }]);
  });

  test('each scheduled tick sends another heartbeat', async () => {
    const session = signedInSession('access-1');
    const client = { heartbeat: vi.fn().mockResolvedValue({ ok: true, status: 204 }) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.5.0', setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await hb.start();            // immediate beat (1)
    await sched.tick();          // beat (2)
    await sched.tick();          // beat (3)

    expect(client.heartbeat).toHaveBeenCalledTimes(3);
  });

  test('skips the heartbeat when the session has no usable token (signed out / refresh rejected)', async () => {
    const session = { getAccessToken: vi.fn().mockResolvedValue(null) };
    const client = { heartbeat: vi.fn() };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.5.0', setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await hb.start();

    expect(client.heartbeat).not.toHaveBeenCalled();
    // the loop stays scheduled so it recovers once the session resumes
    expect(sched.hasCallback()).toBe(true);
  });

  test('start() is idempotent — a second call does not schedule a second interval', async () => {
    const session = signedInSession();
    const client = { heartbeat: vi.fn().mockResolvedValue({ ok: true }) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.5.0', setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await hb.start();
    await hb.start();

    expect(sched.setInterval).toHaveBeenCalledTimes(1);
  });

  test('stop() cancels the interval and stops further beats', async () => {
    const session = signedInSession();
    const client = { heartbeat: vi.fn().mockResolvedValue({ ok: true }) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.5.0', setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await hb.start();
    hb.stop();

    expect(sched.clearInterval).toHaveBeenCalledWith(1);
    expect(sched.hasCallback()).toBe(false);
    // after stop, start() can schedule again (restartable)
    await hb.start();
    expect(sched.setInterval).toHaveBeenCalledTimes(2);
  });

  test('a rejected heartbeat does not throw out of a tick (keeps the loop alive)', async () => {
    const session = signedInSession();
    const client = { heartbeat: vi.fn().mockRejectedValue(new Error('boom')) };
    const sched = fakeScheduler();
    const hb = createHeartbeat({ session, client, version: '1.5.0', setInterval: sched.setInterval, clearInterval: sched.clearInterval });

    await expect(hb.start()).resolves.toBeUndefined();
    await expect(sched.tick()).resolves.toBeUndefined();
  });
});
