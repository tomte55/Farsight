// packages/host/src/transfer-worker-preload.cjs
// CommonJS because the worker renderer runs with sandbox: true (R-7), mirroring
// preload.cjs. main passes this worker's unique id via
// webPreferences.additionalArguments (see transfer-worker.js's createTransferWorker),
// so every IPC topic here is namespaced per worker — two concurrently-open
// transfer workers can never cross streams. Mirrors the controller's
// packages/controller/src/transfer-worker-preload.cjs verbatim.
const { contextBridge, ipcRenderer } = require('electron');

const workerIdArg = process.argv.find((a) => a.startsWith('--ft-worker-id='));
const workerId = workerIdArg ? workerIdArg.slice('--ft-worker-id='.length) : 'unknown';

// MUST mirror transfer-worker.js's topicsFor() — checked by
// transfer-worker-wiring.test.js.
const topics = {
  ctrlOut: `ft-ctrl:${workerId}`,
  bulkOut: `ft-bulk:${workerId}`,
  ctrlIn: `ft-ctrl-in:${workerId}`,
  bulkIn: `ft-bulk-in:${workerId}`,
  credit: `ft-bulk-credit:${workerId}`,
  startRendezvous: `ft-start-rendezvous:${workerId}`,
  sessionState: `ft-session-state:${workerId}`,
  statsRequest: `ft-stats-request:${workerId}`,
  statsResponse: `ft-stats-response:${workerId}`,
};

contextBridge.exposeInMainWorld('farsightTransfer', {
  // Rendezvous params from main: { role, signalingUrl, targetId?, password?,
  // linked?, sessionId?, version? }.
  onStartRendezvous: (cb) => ipcRenderer.on(topics.startRendezvous, (_e, params) => cb(params)),
  // Ctrl/bulk frames main wants SENT out over the WebRTC data channels.
  onSendCtrl: (cb) => ipcRenderer.on(topics.ctrlOut, (_e, str) => cb(str)),
  onSendBulk: (cb) => ipcRenderer.on(topics.bulkOut, (_e, buf) => cb(buf)),
  // Ctrl/bulk frames RECEIVED over the data channels, forwarded up to main.
  emitCtrl: (str) => ipcRenderer.send(topics.ctrlIn, str),
  emitBulk: (buf) => ipcRenderer.send(topics.bulkIn, buf),
  // Backpressure: one credit = one more sendBulk permit (shared/transfer-channel.js).
  emitCredit: () => ipcRenderer.send(topics.credit),
  // Connection-state changes (mirrors peer.js's onConnectionState).
  reportSessionState: (state) => ipcRenderer.send(topics.sessionState, state),
  // getStats: main asks (statsRequest), the worker replies (statsResponse) —
  // the RTCPeerConnection lives in this renderer, not in main.
  onStatsRequest: (cb) => ipcRenderer.on(topics.statsRequest, () => cb()),
  reportStats: (stats) => ipcRenderer.send(topics.statsResponse, stats),
});
