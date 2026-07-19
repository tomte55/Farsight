// packages/controller/src/transfer-worker.js
// SP3 transfer worker (design doc §3): a hidden BrowserWindow that owns the
// transfer RTCPeerConnection + its own signaling WebSocket, reusing the whole
// proven Chromium ICE/TURN/candidate/ICE-restart stack (peer.js,
// signaling-client.js) with zero new native dependencies — a deliberate,
// documented deviation from "WebRTC lives in main" (see the design doc's
// decision #1). Main stays the only process that touches disk or makes policy
// decisions; the worker is a dumb pipe.
//
// NOT wired into app.whenReady() yet — createTransferWorker() is exported for
// a later orchestrator/UI plan to call. Multiple workers may exist at once
// (e.g. one send, one receive), so every IPC topic is namespaced per worker
// via a unique workerId — two workers can never cross streams.
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransferChannel } from '@farsight/shared/transfer-channel';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let workerCounter = 0;

// Every IPC topic this worker uses, namespaced by workerId. Mirrored (must
// stay in sync) in transfer-worker-preload.cjs, which derives the same names
// from the workerId passed via webPreferences.additionalArguments.
function topicsFor(workerId) {
  return {
    ctrlOut: `ft-ctrl:${workerId}`, // main -> worker renderer: ctrl frame to send over WebRTC
    bulkOut: `ft-bulk:${workerId}`, // main -> worker renderer: bulk chunk to send over WebRTC
    ctrlIn: `ft-ctrl-in:${workerId}`, // worker renderer -> main: ctrl frame received over WebRTC
    bulkIn: `ft-bulk-in:${workerId}`, // worker renderer -> main: bulk chunk received over WebRTC
    credit: `ft-bulk-credit:${workerId}`, // worker renderer -> main: bufferedamountlow (backpressure)
    startRendezvous: `ft-start-rendezvous:${workerId}`, // main -> worker renderer: begin signaling
    sessionState: `ft-session-state:${workerId}`, // worker renderer -> main: RTCPeerConnection state
    statsRequest: `ft-stats-request:${workerId}`, // main -> worker renderer: please report getStats()
    statsResponse: `ft-stats-response:${workerId}`, // worker renderer -> main: getStats() result
    statusLog: `ft-status-log:${workerId}`, // worker renderer -> main: periodic diagnostic status
    peerAuth: `ft-peer-auth:${workerId}`, // worker renderer -> main: device-keypair-verified peer publicKey (on auth-ok)
    testFault: `ft-test-fault:${workerId}`, // main -> worker renderer: Plan-1b Task 4 transport fault injection (test-hooks only)
  };
}

// Fail-loud cap (Task 3) on the eager F-B10 inbound buffer below. The buffer is
// otherwise unbounded, so an authed-but-misbehaving/flooding peer could pump
// ctrl/bulk frames before the orchestrator subscribes and grow main-process
// memory without limit. The only legitimate pre-subscription content is the
// sender's chunked manifest OFFER (offer_begin/offer_entries/offer_end,
// ≤~48KB ctrl frames) buffered while a multi-flow receive group finishes
// assembling — a generous per-worker backstop covers even a very large folder's
// OFFER, and a real overflow is a flood/bug we surface, never silently absorb.
const INBOUND_BUFFER_MAX_BYTES = 64 * 1024 * 1024;

// Upper-bound byte cost of holding one buffered inbound payload. Strings are ctrl
// frames (JSON) — count UTF-16 storage; bulk chunks arrive as ArrayBuffer/typed
// arrays/Buffer (all expose byteLength).
function inboundFrameBytes(payload) {
  if (payload == null) return 0;
  if (typeof payload === 'string') return payload.length * 2;
  if (typeof payload.byteLength === 'number') return payload.byteLength;
  return 0;
}

export function createTransferWorker({ onLog, inboundBufferMaxBytes = INBOUND_BUFFER_MAX_BYTES, testHooks = false } = {}) {
  workerCounter += 1;
  const workerId = `w${workerCounter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const topics = topicsFor(workerId);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'transfer-worker-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // R-7: defense in depth
      // This window is ALWAYS hidden (show:false) but must pump the WebRTC data
      // channel + IPC continuously. Chromium background-throttles and lowers the
      // priority of hidden renderers, so under CPU contention (e.g. the visible
      // window rendering the Transfers panel) the transfer starves and stalls
      // mid-flight. Keep it running at full speed.
      backgroundThrottling: false,
      // Plan-1b Task 4: the worker renderer only wires its transport fault
      // listener (dropFlowSocket/injectOversizeCtrl/stallFlow) when this flag is
      // present, so no fault code path is live in a production worker. Main passes
      // testHooks:true only under FARSIGHT_TEST_HOOKS=1.
      additionalArguments: [`--ft-worker-id=${workerId}`, ...(testHooks ? ['--ft-test-hooks=1'] : [])],
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'transfer-worker', 'index.html'));

  const registeredListeners = []; // [topic, handler] — removed on close()
  function onIpc(topic, handler) {
    ipcMain.on(topic, handler);
    registeredListeners.push([topic, handler]);
  }
  // The worker renderer only registers its IPC listeners (onStartRendezvous,
  // onSendCtrl, …) once worker.js has loaded and executed. A webContents.send()
  // issued before that is silently DROPPED by Electron — which hit BOTH the
  // rendezvous kickoff AND the sender's first OFFER frame (main emits it the
  // instant the send starts, right after loadFile), so no CONNECT/ATTACH was
  // sent and the receiver never saw the offer → every transfer hung at 0. Queue
  // ALL sends until did-finish-load, then flush in order.
  let rendererReady = false;
  const preReadyQueue = [];
  function sendToWorker(topic, payload) {
    if (win.isDestroyed()) return;
    if (!rendererReady) { preReadyQueue.push([topic, payload]); return; }
    win.webContents.send(topic, payload);
  }
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    for (const [topic, payload] of preReadyQueue) {
      if (!win.isDestroyed()) win.webContents.send(topic, payload);
    }
    preReadyQueue.length = 0;
  });

  // Inbound (worker renderer -> main) buffering — F-B10.
  //
  // The channel's onCtrl/onBulk subscription is LAZY: the orchestrator only
  // subscribes once it is ready to consume. If we register the ipcMain listener
  // only at subscription time, any frame the worker ipcRenderer.send's BEFORE
  // that is silently DROPPED by Electron (ipcMain has no handler yet). Single-
  // flow never hit this — its lone TRANSFER_REQUEST makes the receive
  // orchestrator subscribe at signaling time, before any data channel opens.
  // Multi-flow receive, however, waits for all N flows to assemble the group
  // before subscribing, while flow-0's data channel opens and delivers the
  // manifest OFFER first on a fast wire — so the OFFER was dropped and the
  // receiver hung at no_offer.
  //
  // Fix: register the ipcMain ctrl/bulk-in listeners EAGERLY at worker creation
  // and buffer inbound frames until the orchestrator subscribes, then flush in
  // arrival order and deliver live thereafter. This mirrors preReadyQueue above,
  // which already buffers for the reverse (main -> worker) direction.
  const inbound = {
    'ft-ctrl-in': { buffer: [], bytes: 0, deliver: null },
    'ft-bulk-in': { buffer: [], bytes: 0, deliver: null },
  };
  // Sticky once an overflow fails the flow: further inbound is dropped (bounded)
  // rather than delivered to a torn-down consumer.
  let inboundOverflowed = false;
  function receiveInbound(key, payload) {
    if (inboundOverflowed) return;
    const slot = inbound[key];
    if (slot.deliver) { slot.deliver(payload); return; }
    slot.buffer.push(payload);
    slot.bytes += inboundFrameBytes(payload);
    // Cap the TOTAL buffered across both directions (Task 3). On overflow, fail
    // LOUD — never drop-oldest (the oldest ctrl frame is the manifest OFFER;
    // dropping it is exactly the F-B10 hang). Free what we buffered, surface a
    // terminal error session-state (the send supervisor + receive path both treat
    // error:* as terminal → re-dial or fail the transfer), and log.
    const total = inbound['ft-ctrl-in'].bytes + inbound['ft-bulk-in'].bytes;
    if (total > inboundBufferMaxBytes) {
      inboundOverflowed = true;
      inbound['ft-ctrl-in'].buffer.length = 0; inbound['ft-ctrl-in'].bytes = 0;
      inbound['ft-bulk-in'].buffer.length = 0; inbound['ft-bulk-in'].bytes = 0;
      if (typeof onLog === 'function') {
        try { onLog({ workerId, event: 'inbound-buffer-overflow', maxBytes: inboundBufferMaxBytes }); } catch { /* ignore */ }
      }
      if (sessionStateCb) { try { sessionStateCb('error:inbound_buffer_overflow'); } catch { /* ignore */ } }
    }
  }
  onIpc(topics.ctrlIn, (_e, payload) => receiveInbound('ft-ctrl-in', payload));
  onIpc(topics.bulkIn, (_e, payload) => receiveInbound('ft-bulk-in', payload));

  // The orchestrator's generic 'ft-ctrl'/'ft-bulk' topic names, mapped onto
  // this worker's namespaced ones — this is what keeps two workers isolated.
  const channel = createTransferChannel({
    send: (topic, payload) => {
      if (topic === 'ft-ctrl') sendToWorker(topics.ctrlOut, payload);
      else if (topic === 'ft-bulk') sendToWorker(topics.bulkOut, payload);
    },
    on: (topic, cb) => {
      if (topic === 'ft-ctrl-in' || topic === 'ft-bulk-in') {
        // Attach the live subscriber and flush anything buffered pre-subscription.
        const slot = inbound[topic];
        slot.deliver = cb;
        const queued = slot.buffer.splice(0);
        slot.bytes = 0; // flushed frames no longer count against the cap
        for (const payload of queued) cb(payload);
      } else if (topic === 'ft-bulk-credit') {
        onIpc(topics.credit, () => cb());
      }
    },
  });

  let sessionStateCb = null;
  onIpc(topics.sessionState, (_e, state) => { if (sessionStateCb) sessionStateCb(state); });

  // SP3 Task 5: the worker reports the device-keypair-VERIFIED peer once on
  // auth-ok, so main can classify it (fleet vs contact) for the consent
  // decision (Task 6). Mirrors sessionState's onIpc + callback plumbing.
  let peerAuthCb = null;
  onIpc(topics.peerAuth, (_e, obj) => { if (peerAuthCb) peerAuthCb(obj); });

  // Diagnostic: the worker renderer periodically reports its transport status
  // (connection/data-channel state, bufferedAmount, message counters). Routed to
  // the app log so a stalled transfer can be diagnosed from a user's logs.
  if (typeof onLog === 'function') onIpc(topics.statusLog, (_e, obj) => { try { onLog({ workerId, ...obj }); } catch { /* ignore */ } });

  let closed = false;

  // F-B2 (Plan 1b Task 6): detect a worker RENDERER CRASH. Without this, a
  // post-accept crash left main sending into a dead renderer — single-flow awaited
  // a credit forever, multi-flow never learned the slot died, and rendererReady
  // stayed true so a would-be reload never re-queued sends. Surface a terminal
  // session-state (the supervisor re-dials the slot; a lone flow fails the transfer
  // loudly) AND fail the channel (rejects any in-flight sendBulk so the send pool's
  // Promise.race unwinds instead of hanging on the dead flow), then reset
  // rendererReady so a reload re-flushes through the pre-ready queue. Guarded so a
  // crash after close() (intentional teardown) is silent.
  function onWorkerGone(reason) {
    if (closed) return;
    rendererReady = false;
    if (typeof onLog === 'function') { try { onLog({ workerId, event: `worker-gone:${reason}` }); } catch { /* ignore */ } }
    if (sessionStateCb) { try { sessionStateCb(`error:worker_${reason}`); } catch { /* ignore */ } }
    try { channel.fail('worker_gone'); } catch { /* ignore */ }
  }
  win.webContents.on('render-process-gone', (_e, details) => onWorkerGone((details && details.reason) || 'crashed'));
  win.webContents.on('unresponsive', () => onWorkerGone('unresponsive'));

  return {
    // params: { role: 'initiator'|'attach', signalingUrl, targetId?, password?,
    // linked?, sessionId?, version?, groupId?, flowIndex?, flowCount? } — see
    // docs/private/.../sp3-flagship design §4.2/§4.3 for the two rendezvous
    // shapes; groupId/flowIndex/flowCount (Plan 3 Task 4) are undefined for a
    // plain single-flow transfer and forwarded opaquely onto the CONNECT/ATTACH
    // sent by transfer-worker/worker.js — this function itself is a transparent
    // passthrough (sendToWorker queues until did-finish-load either way).
    startRendezvous(params) {
      // sendToWorker queues until did-finish-load, so the kickoff is never dropped.
      sendToWorker(topics.startRendezvous, params);
    },
    channel,
    onSessionState(cb) { sessionStateCb = cb; },
    onPeerAuth(cb) { peerAuthCb = cb; },
    // Plan-1b Task 4: forward a transport fault into this worker's renderer
    // (dropFlowSocket/injectOversizeCtrl/stallFlow/resumeFlow). Only ever called
    // by the env-gated faultHooks.dispatch; the renderer only acts on it when
    // launched with --ft-test-hooks=1. sendToWorker queues until did-finish-load.
    sendTestFault(cmd, args) { sendToWorker(topics.testFault, { cmd, args: args || {} }); },
    // Plan-1b Task 4/6 fault injection ONLY (killWorker): force a renderer crash so
    // the render-process-gone path (F-B2) fires — faithfully simulating a worker
    // process death, unlike close() (a clean destroy that never crashes). Gated:
    // only reachable via the env-gated faultHooks.dispatch.
    crashRenderer() { try { if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); } catch { /* ignore */ } },
    // Round-trips a getStats() request to the worker renderer's
    // RTCPeerConnection (main has no direct WebRTC handle — the PC lives in
    // the worker renderer). Resolves [] on timeout/teardown rather than
    // hanging a caller forever.
    getStats(timeoutMs = 5000) {
      return new Promise((resolve) => {
        if (closed || win.isDestroyed()) { resolve([]); return; }
        let settled = false;
        const responseHandler = (_e, stats) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ipcMain.removeListener(topics.statsResponse, responseHandler);
          resolve(stats || []);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ipcMain.removeListener(topics.statsResponse, responseHandler);
          resolve([]);
        }, timeoutMs);
        ipcMain.on(topics.statsResponse, responseHandler);
        sendToWorker(topics.statsRequest, undefined);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [topic, handler] of registeredListeners) ipcMain.removeListener(topic, handler);
      registeredListeners.length = 0;
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
