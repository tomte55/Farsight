// packages/shared/test/transfer-channel.test.js
// createTransferChannel() adapts injected IPC primitives (send/on) into the
// orchestrator's channel contract. Pure — no Electron, no WebRTC: `send` and
// `on` are fakes here; production wires them to ipcRenderer/ipcMain.
import { expect, test, vi } from 'vitest';
import { createTransferChannel } from '../src/transfer-channel.js';

// A minimal fake pub/sub standing in for ipcRenderer.send/ipcRenderer.on (or
// the main-side webContents.send/ipcMain.on equivalents).
function fakeBus() {
  const handlers = new Map(); // topic -> [cb]
  return {
    send: vi.fn(),
    on: vi.fn((topic, cb) => {
      const list = handlers.get(topic) || [];
      list.push(cb);
      handlers.set(topic, list);
    }),
    emit(topic, ...args) {
      for (const cb of handlers.get(topic) || []) cb(...args);
    },
  };
}

test('sendCtrl sends the string on the ft-ctrl topic', () => {
  const bus = fakeBus();
  const channel = createTransferChannel({ send: bus.send, on: bus.on });
  channel.sendCtrl('{"t":"offer"}');
  expect(bus.send).toHaveBeenCalledWith('ft-ctrl', '{"t":"offer"}');
});

test('sendBulk sends the buffer on the ft-bulk topic', () => {
  const bus = fakeBus();
  const channel = createTransferChannel({ send: bus.send, on: bus.on });
  const buf = new ArrayBuffer(4);
  channel.sendBulk(buf);
  expect(bus.send).toHaveBeenCalledWith('ft-bulk', buf);
});

test('onCtrl registers via on(ft-ctrl-in) and delivers frames', () => {
  const bus = fakeBus();
  const channel = createTransferChannel({ send: bus.send, on: bus.on });
  const cb = vi.fn();
  channel.onCtrl(cb);
  expect(bus.on).toHaveBeenCalledWith('ft-ctrl-in', expect.any(Function));
  bus.emit('ft-ctrl-in', '{"t":"accept"}');
  expect(cb).toHaveBeenCalledWith('{"t":"accept"}');
});

test('onBulk registers via on(ft-bulk-in) and delivers frames', () => {
  const bus = fakeBus();
  const channel = createTransferChannel({ send: bus.send, on: bus.on });
  const cb = vi.fn();
  channel.onBulk(cb);
  expect(bus.on).toHaveBeenCalledWith('ft-bulk-in', expect.any(Function));
  const buf = new ArrayBuffer(8);
  bus.emit('ft-bulk-in', buf);
  expect(cb).toHaveBeenCalledWith(buf);
});

test('sendBulk resolves immediately when no credit signal is injected (no `on`)', async () => {
  const send = vi.fn();
  const channel = createTransferChannel({ send });
  let resolved = false;
  channel.sendBulk(new ArrayBuffer(1)).then(() => { resolved = true; });
  await Promise.resolve();
  await Promise.resolve();
  expect(resolved).toBe(true);
});

test('sendBulk awaits the injected ft-bulk-credit signal before resolving (backpressure)', async () => {
  const bus = fakeBus();
  const channel = createTransferChannel({ send: bus.send, on: bus.on });
  let resolved = false;
  const p = channel.sendBulk(new ArrayBuffer(1)).then(() => { resolved = true; });

  // Not resolved yet — no credit signal has fired.
  await Promise.resolve();
  await Promise.resolve();
  expect(resolved).toBe(false);

  bus.emit('ft-bulk-credit');
  await p;
  expect(resolved).toBe(true);
});

test('a credit signal only releases one pending sendBulk (one credit = one send permit)', async () => {
  const bus = fakeBus();
  const channel = createTransferChannel({ send: bus.send, on: bus.on });
  let resolvedCount = 0;
  const mark = () => { resolvedCount += 1; };
  channel.sendBulk(new ArrayBuffer(1)).then(mark);
  channel.sendBulk(new ArrayBuffer(1)).then(mark);

  bus.emit('ft-bulk-credit');
  await Promise.resolve();
  await Promise.resolve();
  expect(resolvedCount).toBe(1);

  bus.emit('ft-bulk-credit');
  await Promise.resolve();
  await Promise.resolve();
  expect(resolvedCount).toBe(2);
});

test('createTransferChannel registers the credit listener exactly once, not per sendBulk call', () => {
  const bus = fakeBus();
  const channel = createTransferChannel({ send: bus.send, on: bus.on });
  channel.sendBulk(new ArrayBuffer(1));
  channel.sendBulk(new ArrayBuffer(1));
  const creditRegistrations = bus.on.mock.calls.filter(([topic]) => topic === 'ft-bulk-credit');
  expect(creditRegistrations.length).toBe(1);
});
