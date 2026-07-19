// packages/controller/test/transfer-worker-crash.test.js
// F-B2 (Plan 1b Task 6): a transfer worker's RENDERER CRASH must be detected.
// Before, no render-process-gone/unresponsive listener existed on the worker
// webContents, so a post-accept crash left main sending into a dead renderer —
// single-flow awaited a credit forever, multi-flow never learned the slot died.
//
// This drives the REAL createTransferWorker with a mocked Electron boundary whose
// webContents records its event handlers, then fires 'render-process-gone' and
// asserts the BEHAVIOUR: a terminal error:worker_* session-state is reported AND
// the channel is failed (so the send pool unwinds instead of hanging). Mutation
// check: delete the render-process-gone handler in transfer-worker.js and both
// assertions fail; drop channel.fail and the fail-spy assertion fails.
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { ipcMainMock, lastWin } = vi.hoisted(() => {
  const listeners = new Map();
  const ipcMainMock = {
    on(topic, handler) { if (!listeners.has(topic)) listeners.set(topic, new Set()); listeners.get(topic).add(handler); },
    removeListener(topic, handler) { listeners.get(topic)?.delete(handler); },
    _reset() { listeners.clear(); },
  };
  const lastWin = { current: null };
  return { ipcMainMock, lastWin };
});

vi.mock('electron', () => {
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this.wcHandlers = {}; // event -> handler (render-process-gone, unresponsive, did-finish-load, ...)
      this.crashed = false;
      this.webContents = {
        on: (evt, fn) => { this.wcHandlers[evt] = fn; },
        send() {},
        setWindowOpenHandler() {},
        getURL() { return ''; },
        forcefullyCrashRenderer: () => { this.crashed = true; if (this.wcHandlers['render-process-gone']) this.wcHandlers['render-process-gone']({}, { reason: 'crashed' }); },
      };
      lastWin.current = this;
    }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  return { ipcMain: ipcMainMock, BrowserWindow: FakeBrowserWindow };
});

const { createTransferWorker } = await import('../src/transfer-worker.js');

beforeEach(() => ipcMainMock._reset());

describe('createTransferWorker detects a renderer crash (F-B2)', () => {
  test('render-process-gone -> terminal error:worker_* session-state AND channel.fail()', () => {
    const worker = createTransferWorker();
    const states = [];
    worker.onSessionState((s) => states.push(s));
    const failSpy = vi.spyOn(worker.channel, 'fail');

    // The crash listener must be wired on the worker webContents.
    expect(typeof lastWin.current.wcHandlers['render-process-gone']).toBe('function');

    lastWin.current.wcHandlers['render-process-gone']({}, { reason: 'crashed' });

    expect(states.some((s) => typeof s === 'string' && s.startsWith('error:worker_'))).toBe(true);
    expect(failSpy).toHaveBeenCalled(); // in-flight sendBulk rejected so the pool unwinds
    worker.close();
  });

  test('unresponsive is also treated as a terminal worker death', () => {
    const worker = createTransferWorker();
    const states = [];
    worker.onSessionState((s) => states.push(s));

    expect(typeof lastWin.current.wcHandlers['unresponsive']).toBe('function');
    lastWin.current.wcHandlers['unresponsive']();

    expect(states).toContain('error:worker_unresponsive');
    worker.close();
  });

  test('crashRenderer() forces a renderer crash (the killWorker fault path)', () => {
    const worker = createTransferWorker();
    const states = [];
    worker.onSessionState((s) => states.push(s));

    worker.crashRenderer();
    expect(lastWin.current.crashed).toBe(true);
    // crashRenderer fires render-process-gone in the fake -> terminal surfaced
    expect(states.some((s) => typeof s === 'string' && s.startsWith('error:worker_'))).toBe(true);
    worker.close();
  });

  test('a crash AFTER close() is silent (intentional teardown, no spurious terminal)', () => {
    const worker = createTransferWorker();
    const states = [];
    worker.onSessionState((s) => states.push(s));
    worker.close();
    // A late crash event on the torn-down worker must not surface a new terminal.
    lastWin.current.wcHandlers['render-process-gone']?.({}, { reason: 'crashed' });
    expect(states).toEqual([]);
  });
});
