// packages/controller/src/transfer-fault-hooks.js
// Plan-1b Task 4: the addressing + GATING core of the real-wire fault-injection
// infrastructure. Main populates a (side, flowIndex) -> transfer-worker registry
// as workers are created, and the env-gated `ft-test:fault` IPC dispatches a
// named fault to the addressed worker (killWorker main-side; the transport faults
// forwarded into the worker renderer via worker.sendTestFault).
//
// SECURITY (CLAUDE.md / plan): the whole subsystem is INERT unless the caller
// passes `enabled: true` (main derives that from FARSIGHT_TEST_HOOKS=1). Disabled,
// register()/unregister() are no-ops and dispatch() refuses — so a production
// build (which never sets the flag, and never registers the IPC handler) exposes
// nothing. This module is deliberately Electron-free so the gate + addressing are
// unit-testable without a real Electron process (main.js is not importable
// outside one).
//
// Faults:
//   killWorker        — CRASH the addressed worker's renderer process
//                       (forcefullyCrashRenderer → render-process-gone), simulating
//                       F-B2 worker-process death. NOT worker.close(): a clean
//                       destroy never fires render-process-gone. Main-side only.
//   dropFlowSocket    — close the worker's signaling WebSocket (F-B1). Renderer.
//   injectOversizeCtrl— send a ctrl frame over the ~256KB DC send limit (F-B3).
//   stallFlow/resumeFlow — pause/resume the flow's outbound bulk (shaping/wedge).
// The transport faults are performed inside the worker renderer, addressed here
// and forwarded opaquely via worker.sendTestFault(cmd, args).

const TRANSPORT_FAULTS = new Set(['dropFlowSocket', 'injectOversizeCtrl', 'stallFlow', 'resumeFlow']);

export function createFaultHooks({ enabled = false } = {}) {
  // side -> Map<flowIndex, worker>. Only ever populated when enabled.
  const workers = { send: new Map(), receive: new Map() };

  function register(side, flowIndex, worker) {
    if (!enabled) return;
    if (!workers[side]) workers[side] = new Map();
    workers[side].set(flowIndex, worker);
  }

  // Remove a worker from its slot — but ONLY if it is still the slot's current
  // occupant. A re-dial replaces slot N's worker before the dead one's close()
  // fires its unregister; evicting unconditionally would then drop the live
  // replacement from the registry.
  function unregister(side, flowIndex, worker) {
    if (!enabled) return;
    const m = workers[side];
    if (m && m.get(flowIndex) === worker) m.delete(flowIndex);
  }

  async function dispatch({ cmd, side, flowIndex, ...args } = {}) {
    if (!enabled) throw new Error('fault_hooks_disabled');
    const worker = workers[side] && workers[side].get(flowIndex);
    if (!worker) throw new Error(`no_worker:${side}:${flowIndex}`);
    if (cmd === 'killWorker') {
      if (typeof worker.crashRenderer !== 'function') throw new Error('worker_no_crash');
      worker.crashRenderer();
      return { ok: true };
    }
    if (TRANSPORT_FAULTS.has(cmd)) {
      if (typeof worker.sendTestFault !== 'function') throw new Error('worker_no_test_fault');
      worker.sendTestFault(cmd, args);
      return { ok: true };
    }
    throw new Error(`unknown_fault:${cmd}`);
  }

  return {
    enabled,
    register,
    unregister,
    dispatch,
    // Diagnostic only (tests + logging): how many workers are currently registered
    // for a side.
    _size: (side) => (workers[side] ? workers[side].size : 0),
  };
}
