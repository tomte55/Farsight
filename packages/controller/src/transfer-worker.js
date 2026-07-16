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
  };
}

export function createTransferWorker({ onLog } = {}) {
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
      additionalArguments: [`--ft-worker-id=${workerId}`],
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

  // The orchestrator's generic 'ft-ctrl'/'ft-bulk' topic names, mapped onto
  // this worker's namespaced ones — this is what keeps two workers isolated.
  const channel = createTransferChannel({
    send: (topic, payload) => {
      if (topic === 'ft-ctrl') sendToWorker(topics.ctrlOut, payload);
      else if (topic === 'ft-bulk') sendToWorker(topics.bulkOut, payload);
    },
    on: (topic, cb) => {
      if (topic === 'ft-ctrl-in') onIpc(topics.ctrlIn, (_e, payload) => cb(payload));
      else if (topic === 'ft-bulk-in') onIpc(topics.bulkIn, (_e, payload) => cb(payload));
      else if (topic === 'ft-bulk-credit') onIpc(topics.credit, () => cb());
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

  return {
    // params: { role: 'initiator'|'attach', signalingUrl, targetId?, password?,
    // linked?, sessionId?, version? } — see docs/private/.../sp3-flagship
    // design §4.2/§4.3 for the two rendezvous shapes.
    startRendezvous(params) {
      // sendToWorker queues until did-finish-load, so the kickoff is never dropped.
      sendToWorker(topics.startRendezvous, params);
    },
    channel,
    onSessionState(cb) { sessionStateCb = cb; },
    onPeerAuth(cb) { peerAuthCb = cb; },
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
