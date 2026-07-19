// packages/controller/test/transfer-worker-inbound-buffer.test.js
// BEHAVIORAL guard for F-B10 (the multi-flow OFFER-drop race).
//
// createTransferWorker() bridges the worker renderer -> main direction over
// ipcMain. The channel's onCtrl/onBulk subscription is LAZY (multi-flow receive
// only subscribes once the whole flow group has assembled). A frame that arrives
// BEFORE that subscription must NOT be dropped — on the real wire flow-0's data
// channel opens and delivers the manifest OFFER before the group finishes
// assembling, and dropping it hangs the receiver at no_offer.
//
// This exercises the real createTransferWorker with a mocked Electron IPC
// boundary (ipcMain + BrowserWindow), so it pins the BEHAVIOUR — a pre-subscribe
// inbound frame is buffered and later delivered — not a source string. Mutation
// check: revert the eager-registration + buffer in transfer-worker.js and both
// tests fail (the ctrl/bulk-in listener no longer exists until onCtrl/onBulk, so
// the early frame lands on a topic with no handler and is silently dropped).
import { describe, test, expect, vi, beforeEach } from 'vitest';

// A tiny stand-in for Electron's ipcMain (topic -> handlers) and BrowserWindow.
// Hoisted so the vi.mock('electron') factory can close over it AND the tests can
// drive it. Self-contained (no imports) to survive vi.mock hoisting.
const { ipcMainMock } = vi.hoisted(() => {
  const listeners = new Map(); // topic -> Set<handler>
  const ipcMainMock = {
    on(topic, handler) {
      if (!listeners.has(topic)) listeners.set(topic, new Set());
      listeners.get(topic).add(handler);
    },
    removeListener(topic, handler) { listeners.get(topic)?.delete(handler); },
    emit(topic, ...args) {
      const hs = listeners.get(topic);
      if (!hs) return false;
      for (const h of [...hs]) h(...args); // Electron calls handler(event, ...payload)
      return true;
    },
    _topics() { return [...listeners.keys()]; },
    _reset() { listeners.clear(); },
  };
  return { ipcMainMock };
});

vi.mock('electron', () => {
  class FakeBrowserWindow {
    constructor() {
      this.webContents = {
        on() {},
        send() {},
        setWindowOpenHandler() {},
        getURL() { return ''; },
      };
    }
    loadFile() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  return { ipcMain: ipcMainMock, BrowserWindow: FakeBrowserWindow };
});

const { createTransferWorker } = await import('../src/transfer-worker.js');

beforeEach(() => ipcMainMock._reset());

describe('createTransferWorker buffers inbound worker->main frames until the orchestrator subscribes (F-B10)', () => {
  test('a ctrl frame arriving BEFORE onCtrl is buffered, then delivered, and live frames follow in order', () => {
    const worker = createTransferWorker();

    // The inbound ctrl listener must exist EAGERLY at worker creation, before any
    // onCtrl subscription — that is the whole fix.
    const ctrlInTopic = ipcMainMock._topics().find((t) => t.startsWith('ft-ctrl-in:'));
    expect(ctrlInTopic).toBeTruthy();

    // OFFER arrives on the wire before the receive orchestrator subscribes.
    ipcMainMock.emit(ctrlInTopic, {}, 'OFFER');

    const got = [];
    worker.channel.onCtrl((frame) => got.push(frame));

    // Buffered pre-subscription frame is flushed on subscribe.
    expect(got).toEqual(['OFFER']);

    // Frames after subscription deliver live, preserving arrival order.
    ipcMainMock.emit(ctrlInTopic, {}, 'SECOND');
    expect(got).toEqual(['OFFER', 'SECOND']);

    worker.close();
  });

  test('a bulk frame arriving BEFORE onBulk is buffered, then delivered', () => {
    const worker = createTransferWorker();

    const bulkInTopic = ipcMainMock._topics().find((t) => t.startsWith('ft-bulk-in:'));
    expect(bulkInTopic).toBeTruthy();

    ipcMainMock.emit(bulkInTopic, {}, 'CHUNK0');

    const got = [];
    worker.channel.onBulk((frame) => got.push(frame));
    expect(got).toEqual(['CHUNK0']);

    worker.close();
  });
});

describe('createTransferWorker caps the pre-subscription inbound buffer and fails loud on overflow (Task 3)', () => {
  // The eager F-B10 buffer above is otherwise UNBOUNDED: an authed-but-
  // misbehaving/flooding peer could pump ctrl/bulk frames before the orchestrator
  // subscribes and grow main-process memory without limit. The legit content is
  // only the sender's chunked manifest OFFER, so we cap total buffered bytes and,
  // on overflow, FAIL LOUD — never silently. We do NOT drop-oldest: the oldest
  // ctrl frame is the OFFER, and dropping it is exactly the F-B10 hang.
  //
  // Mutation check: delete the overflow branch in receiveInbound (transfer-worker.js)
  // and the first test fails (no terminal state, no log, unbounded buffering);
  // change `>` to `>=`/raise the cap and the boundary assertions drift.

  test('a pre-subscription flood past the cap surfaces a terminal session-state + log, frees the buffer, and stays failed', () => {
    const logs = [];
    // Small injected cap so the test is fast + deterministic (prod default is a
    // generous per-worker backstop, exercised in real use, not here).
    const worker = createTransferWorker({ onLog: (o) => logs.push(o), inboundBufferMaxBytes: 100 });
    const states = [];
    worker.onSessionState((s) => states.push(s));

    const ctrlInTopic = ipcMainMock._topics().find((t) => t.startsWith('ft-ctrl-in:'));

    // The OFFER lands first — it must never be the thing sacrificed.
    ipcMainMock.emit(ctrlInTopic, {}, 'OFFER');
    // Then a flood pushes total buffered bytes past the cap.
    ipcMainMock.emit(ctrlInTopic, {}, 'x'.repeat(80)); // 160 bytes (UTF-16) > 100

    // Fail LOUD: an explicit terminal error state (the supervisor/receive path
    // treats error:* as terminal → tear down + re-dial or fail the transfer) plus
    // a log line — not silent growth and not a silent OFFER drop.
    expect(states).toContain('error:inbound_buffer_overflow');
    expect(logs.some((o) => o.event === 'inbound-buffer-overflow')).toBe(true);

    // The buffered frames were freed and the flow is sticky-failed: a late
    // subscribe delivers nothing, and further inbound frames are dropped (bounded).
    const got = [];
    worker.channel.onCtrl((f) => got.push(f));
    expect(got).toEqual([]);
    ipcMainMock.emit(ctrlInTopic, {}, 'LATE');
    expect(got).toEqual([]);

    worker.close();
  });

  test('a pre-subscription burst UNDER the cap still buffers and delivers every frame in order (F-B10 fix intact)', () => {
    const worker = createTransferWorker({ inboundBufferMaxBytes: 10_000 });
    const ctrlInTopic = ipcMainMock._topics().find((t) => t.startsWith('ft-ctrl-in:'));

    ipcMainMock.emit(ctrlInTopic, {}, 'OFFER');
    ipcMainMock.emit(ctrlInTopic, {}, 'A');
    ipcMainMock.emit(ctrlInTopic, {}, 'B');

    const got = [];
    worker.channel.onCtrl((f) => got.push(f));
    expect(got).toEqual(['OFFER', 'A', 'B']);

    worker.close();
  });

  test('ctrl and bulk buffers share one byte budget — a flood split across both still trips the cap', () => {
    const logs = [];
    const worker = createTransferWorker({ onLog: (o) => logs.push(o), inboundBufferMaxBytes: 100 });
    const states = [];
    worker.onSessionState((s) => states.push(s));

    const ctrlInTopic = ipcMainMock._topics().find((t) => t.startsWith('ft-ctrl-in:'));
    const bulkInTopic = ipcMainMock._topics().find((t) => t.startsWith('ft-bulk-in:'));

    ipcMainMock.emit(ctrlInTopic, {}, 'x'.repeat(30)); // 60 bytes
    expect(states).not.toContain('error:inbound_buffer_overflow'); // under cap so far
    ipcMainMock.emit(bulkInTopic, {}, 'y'.repeat(30)); // +60 = 120 > 100

    expect(states).toContain('error:inbound_buffer_overflow');
    expect(logs.some((o) => o.event === 'inbound-buffer-overflow')).toBe(true);

    worker.close();
  });
});
