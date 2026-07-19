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
