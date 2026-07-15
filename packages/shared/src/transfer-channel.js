// packages/shared/src/transfer-channel.js
// SP3 (design §3, §8.4): adapts injected IPC primitives into the orchestrator's
// channel contract `{ sendCtrl, sendBulk, onCtrl, onBulk }`. MAIN-ONLY in
// production (the transfer-orchestrator lives in main), but kept pure and
// runtime-agnostic like the rest of shared/ — no Electron import here. `send`
// and `on` are injected: production wires them to ipcMain/webContents.send for
// a specific worker window (see controller/src/transfer-worker.js); tests
// inject fakes.
//
// Backpressure (design §7, IPC stage): `sendBulk` sends the chunk immediately,
// then returns a Promise that resolves once the worker signals capacity via an
// 'ft-bulk-credit' event on the injected `on`. This lets main throttle its
// disk-read loop to the channel's real drain rate instead of buffering
// unboundedly in the IPC layer. If no `on` is injected at all, there is no
// credit source to wait on, so sendBulk resolves immediately (used by callers
// that don't need backpressure, e.g. simple tests).
export function createTransferChannel({ send, on }) {
  let creditWaiters = [];
  let creditListenerRegistered = false;

  function ensureCreditListener() {
    if (creditListenerRegistered || typeof on !== 'function') return;
    creditListenerRegistered = true;
    on('ft-bulk-credit', () => {
      // One credit event releases exactly one pending sendBulk waiter — mirrors
      // one 'bufferedamountlow' firing granting one more chunk's worth of room.
      const waiter = creditWaiters.shift();
      if (waiter) waiter();
    });
  }

  return {
    sendCtrl(str) {
      send('ft-ctrl', str);
    },
    sendBulk(buf) {
      send('ft-bulk', buf);
      if (typeof on !== 'function') return Promise.resolve();
      ensureCreditListener();
      return new Promise((resolve) => { creditWaiters.push(resolve); });
    },
    onCtrl(cb) {
      if (typeof on === 'function') on('ft-ctrl-in', cb);
    },
    onBulk(cb) {
      if (typeof on === 'function') on('ft-bulk-in', cb);
    },
  };
}
