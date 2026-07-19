// packages/controller/test/transfer-fault-hooks.test.js
// Unit guard for the Plan-1b Task 4 fault-injection registry (transfer-fault-hooks.js).
//
// This is the addressing + GATING core of the fault-injection infra: main
// populates a (side, flowIndex) -> worker registry as transfer workers are
// created, and the env-gated ft-test IPC dispatches a named fault to the right
// worker. The security-critical invariant (CLAUDE.md / plan: "NEVER present/active
// in production builds") is that with the FARSIGHT_TEST_HOOKS flag OFF the module
// is completely inert: it registers nothing and refuses to dispatch.
//
// Pure/Electron-free by design (main.js can't be imported outside a real Electron
// process), so the gate + addressing + dispatch are all unit-testable here with a
// fake worker. Mutation checks: flip `enabled` handling and the disabled tests
// pass when they must fail; break the (side,flowIndex) lookup and addressing fails.
import { describe, test, expect, vi } from 'vitest';
import { createFaultHooks } from '../src/transfer-fault-hooks.js';

function fakeWorker() {
  return {
    close: vi.fn(async () => {}),
    sendTestFault: vi.fn(),
  };
}

describe('createFaultHooks — DISABLED (no FARSIGHT_TEST_HOOKS) is fully inert', () => {
  test('register is a no-op and dispatch refuses — nothing is reachable', async () => {
    const hooks = createFaultHooks({ enabled: false });
    const w = fakeWorker();
    hooks.register('send', 0, w);
    expect(hooks._size('send')).toBe(0); // registered nothing

    await expect(hooks.dispatch({ cmd: 'killWorker', side: 'send', flowIndex: 0 }))
      .rejects.toThrow(/disabled/);
    expect(w.close).not.toHaveBeenCalled();
  });

  test('default (no options) is disabled', async () => {
    const hooks = createFaultHooks();
    await expect(hooks.dispatch({ cmd: 'killWorker', side: 'send', flowIndex: 0 }))
      .rejects.toThrow(/disabled/);
  });
});

describe('createFaultHooks — ENABLED addresses workers by (side, flowIndex)', () => {
  test('killWorker closes exactly the addressed worker (main-side fault, F-B2)', async () => {
    const hooks = createFaultHooks({ enabled: true });
    const s0 = fakeWorker(); const s1 = fakeWorker(); const r0 = fakeWorker();
    hooks.register('send', 0, s0);
    hooks.register('send', 1, s1);
    hooks.register('receive', 0, r0);

    await hooks.dispatch({ cmd: 'killWorker', side: 'send', flowIndex: 1 });
    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(s0.close).not.toHaveBeenCalled();
    expect(r0.close).not.toHaveBeenCalled();
  });

  test('receive-side addressing is independent of send-side (same flowIndex, different side)', async () => {
    const hooks = createFaultHooks({ enabled: true });
    const s0 = fakeWorker(); const r0 = fakeWorker();
    hooks.register('send', 0, s0);
    hooks.register('receive', 0, r0);

    await hooks.dispatch({ cmd: 'killWorker', side: 'receive', flowIndex: 0 });
    expect(r0.close).toHaveBeenCalledTimes(1);
    expect(s0.close).not.toHaveBeenCalled();
  });

  test('transport faults are forwarded into the addressed worker renderer with their args', async () => {
    const hooks = createFaultHooks({ enabled: true });
    const w = fakeWorker();
    hooks.register('send', 2, w);

    await hooks.dispatch({ cmd: 'dropFlowSocket', side: 'send', flowIndex: 2, when: 'after-open' });
    expect(w.sendTestFault).toHaveBeenCalledWith('dropFlowSocket', { when: 'after-open' });

    await hooks.dispatch({ cmd: 'injectOversizeCtrl', side: 'send', flowIndex: 2, bytes: 300000 });
    expect(w.sendTestFault).toHaveBeenCalledWith('injectOversizeCtrl', { bytes: 300000 });

    await hooks.dispatch({ cmd: 'stallFlow', side: 'send', flowIndex: 2 });
    await hooks.dispatch({ cmd: 'resumeFlow', side: 'send', flowIndex: 2 });
    expect(w.sendTestFault).toHaveBeenCalledWith('stallFlow', {});
    expect(w.sendTestFault).toHaveBeenCalledWith('resumeFlow', {});
    // killWorker never routes through the renderer.
    expect(w.close).not.toHaveBeenCalled();
  });

  test('dispatch to a missing (side, flowIndex) fails loud rather than silently no-op', async () => {
    const hooks = createFaultHooks({ enabled: true });
    await expect(hooks.dispatch({ cmd: 'killWorker', side: 'send', flowIndex: 9 }))
      .rejects.toThrow(/no_worker/);
  });

  test('an unknown fault command fails loud', async () => {
    const hooks = createFaultHooks({ enabled: true });
    hooks.register('send', 0, fakeWorker());
    await expect(hooks.dispatch({ cmd: 'nope', side: 'send', flowIndex: 0 }))
      .rejects.toThrow(/unknown_fault/);
  });

  test('unregister removes only the matching worker, not a replacement re-dial took its slot', async () => {
    const hooks = createFaultHooks({ enabled: true });
    const original = fakeWorker(); const replacement = fakeWorker();
    hooks.register('send', 0, original);
    hooks.register('send', 0, replacement); // a re-dial replaced slot 0
    // The stale original unregistering must NOT evict the live replacement.
    hooks.unregister('send', 0, original);
    expect(hooks._size('send')).toBe(1);
    await hooks.dispatch({ cmd: 'killWorker', side: 'send', flowIndex: 0 });
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(original.close).not.toHaveBeenCalled();
  });
});
