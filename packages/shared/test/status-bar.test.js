// packages/shared/test/status-bar.test.js
import { describe, test, expect } from 'vitest';
import { buildStatusSegments } from '../src/status-bar.js';

const ids = (segs) => segs.map((s) => s.id);
const byId = (segs, id) => segs.find((s) => s.id === id);

describe('buildStatusSegments — idle', () => {
  test('shows signaling state and the version, nothing else', () => {
    const segs = buildStatusSegments({ signaling: 'ready', appVersion: '1.14.6' });
    expect(ids(segs)).toEqual(['state', 'version']);
    expect(byId(segs, 'state').text).toBe('Ready');
    expect(byId(segs, 'state').dot).toBe('acc');
    expect(byId(segs, 'version').text).toBe('v1.14.6');
  });

  test('reports a connecting and an errored signaling link distinctly', () => {
    expect(byId(buildStatusSegments({ signaling: 'connecting' }), 'state').text)
      .toBe('Connecting to signaling…');
    const err = byId(buildStatusSegments({ signaling: 'error' }), 'state');
    expect(err.text).toBe('Signaling unavailable');
    expect(err.dot).toBe('warn');
  });

  test('omits the version segment when the app version is not known yet', () => {
    // appVersion arrives from an unawaited IPC promise (renderer.js getAppVersion),
    // so the first paint genuinely has null here.
    expect(ids(buildStatusSegments({ signaling: 'ready' }))).toEqual(['state']);
  });
});

describe('buildStatusSegments — account', () => {
  test('shows the signed-in identity when present', () => {
    const segs = buildStatusSegments({ signaling: 'ready', signedInAs: 'harry@example.com' });
    expect(ids(segs)).toEqual(['state', 'account']);
    expect(byId(segs, 'account').text).toBe('Signed in as harry@example.com');
  });

  test('shows nothing for the account when signed out', () => {
    expect(byId(buildStatusSegments({ signaling: 'ready' }), 'account')).toBeUndefined();
  });
});

describe('buildStatusSegments — session', () => {
  test('names the peer, and carries rtt/resolution/transport', () => {
    const segs = buildStatusSegments({
      signaling: 'ready',
      session: { peer: 'NUC', rttMs: 12, width: 1920, height: 1080, transport: 'relay' },
    });
    expect(byId(segs, 'session').text).toBe('Connected to NUC');
    expect(byId(segs, 'session').dot).toBe('acc2');
    expect(byId(segs, 'session-detail').text).toBe('12 ms · 1920×1080 · relay');
  });

  test('a session segment focuses the session window when clicked', () => {
    const segs = buildStatusSegments({ signaling: 'ready', session: { peer: 'NUC' } });
    expect(byId(segs, 'session').focus).toBe('session');
  });

  test('drops detail fields that are not known yet rather than printing undefined', () => {
    const segs = buildStatusSegments({ signaling: 'ready', session: { peer: 'NUC', rttMs: 12 } });
    expect(byId(segs, 'session-detail').text).toBe('12 ms');
  });

  test('omits session-detail entirely when no detail is known', () => {
    const segs = buildStatusSegments({ signaling: 'ready', session: { peer: 'NUC' } });
    expect(byId(segs, 'session-detail')).toBeUndefined();
  });
});

describe('buildStatusSegments — transfers', () => {
  const job = {
    jobId: 'j1',
    peer: 'Dad',
    direction: 'send',
    progress: { sent: 44_000_000_000, total: 107_374_182_400 },
    rate: 11_400_000,
    state: 'active',
  };

  test('renders bytes, rate and ETA with a byte-based bar', () => {
    const seg = byId(buildStatusSegments({ signaling: 'ready', transfers: [job] }), 'transfer:j1');
    expect(seg.text).toContain('Dad');
    expect(seg.text).toContain('41.0 GB of 100.0 GB');
    expect(seg.text).toContain('10.9 MB/s');
    expect(seg.text).toMatch(/~\d+h \d+m left/);
    expect(seg.bar).toBeCloseTo(44_000_000_000 / 107_374_182_400, 5);
    expect(seg.focus).toBe('transfers');
  });

  test('suppresses the ETA when the job is not actively moving', () => {
    const seg = byId(
      buildStatusSegments({ signaling: 'ready', transfers: [{ ...job, state: 'interrupted' }] }),
      'transfer:j1',
    );
    expect(seg.text).toContain('41.0 GB of 100.0 GB');
    expect(seg.text).not.toContain('left');
  });

  test('omits rate and ETA before an estimate exists', () => {
    const seg = byId(
      buildStatusSegments({ signaling: 'ready', transfers: [{ ...job, rate: null }] }),
      'transfer:j1',
    );
    expect(seg.text).toContain('41.0 GB of 100.0 GB');
    expect(seg.text).not.toContain('/s');
    expect(seg.text).not.toContain('left');
  });

  test('a receive is arrowed inbound and reads progress from .received', () => {
    const seg = byId(buildStatusSegments({
      signaling: 'ready',
      transfers: [{ jobId: 'j2', peer: 'Dad', direction: 'recv', progress: { received: 512, total: 1024 }, state: 'active' }],
    }), 'transfer:j2');
    expect(seg.text.startsWith('↓')).toBe(true);
    expect(seg.bar).toBeCloseTo(0.5, 5);
  });

  test('terminal jobs never reach the bar', () => {
    const segs = buildStatusSegments({
      signaling: 'ready',
      transfers: [
        { ...job, state: 'done' },
        { ...job, jobId: 'j3', state: 'error' },
        // F-A4: a finished-with-some-failures job is terminal too — it must not
        // keep rendering as a live status-bar segment.
        { ...job, jobId: 'j4', state: 'completed_with_errors' },
      ],
    });
    expect(segs.filter((s) => s.kind === 'transfer')).toHaveLength(0);
  });

  test('a job with no usable total shows the peer without a bar rather than NaN', () => {
    const seg = byId(buildStatusSegments({
      signaling: 'ready',
      transfers: [{ jobId: 'j4', peer: 'Dad', direction: 'send', progress: null, state: 'active' }],
    }), 'transfer:j4');
    expect(seg.bar).toBeNull();
    expect(seg.text).not.toMatch(/NaN|undefined/);
  });

  test('shows every live transfer', () => {
    const segs = buildStatusSegments({
      signaling: 'ready',
      transfers: [job, { ...job, jobId: 'jB', peer: 'NUC' }],
    });
    expect(segs.filter((s) => s.kind === 'transfer').map((s) => s.id))
      .toEqual(['transfer:j1', 'transfer:jB']);
  });
});

describe('buildStatusSegments — update', () => {
  test('surfaces a downloaded update as a warn segment', () => {
    const seg = byId(buildStatusSegments({ signaling: 'ready', update: { version: '1.15.0' } }), 'update');
    expect(seg.kind).toBe('warn');
    expect(seg.text).toBe('Update ready (1.15.0) — restart to install');
    expect(seg.dot).toBe('warn');
    expect(seg.focus).toBe('install-update');
  });

  test('reads without a version when the updater did not report one', () => {
    expect(byId(buildStatusSegments({ signaling: 'ready', update: {} }), 'update').text)
      .toBe('Update ready — restart to install');
  });
});

describe('buildStatusSegments — ordering', () => {
  test('state, account, session, transfers, update, version — in that order', () => {
    const segs = buildStatusSegments({
      signaling: 'ready',
      signedInAs: 'a@b.c',
      session: { peer: 'NUC', rttMs: 9 },
      transfers: [{ jobId: 'j', peer: 'Dad', direction: 'send', progress: { sent: 1, total: 2 }, state: 'active' }],
      update: { version: '1.15.0' },
      appVersion: '1.14.6',
    });
    expect(ids(segs)).toEqual(['state', 'account', 'session', 'session-detail', 'transfer:j', 'update', 'version']);
  });

  test('an empty state object does not throw', () => {
    expect(() => buildStatusSegments({})).not.toThrow();
    expect(() => buildStatusSegments()).not.toThrow();
  });
});
