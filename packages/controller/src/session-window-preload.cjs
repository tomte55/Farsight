// packages/controller/src/session-window-preload.cjs
// CommonJS because the renderer runs with sandbox:true (R-7). The session window's
// bridge is a SUBSET of the shell's — only what the moved session subsystem calls,
// plus the session:launch push from main. Kept separate from the shell's preload so
// the session window exposes no account/transfer/fleet surface it never uses.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('farsightSession', {
  // main -> session: start a connection with {targetId, candidates, linked}.
  onLaunch: (cb) => ipcRenderer.on('session:launch', (_e, params) => cb(params)),
  // session -> shell (via main): live {peer,rttMs,width,height,transport} or null.
  status: (s) => ipcRenderer.send('session:status', s),
  // session -> main: end the session by closing this window (see doClose).
  close: () => ipcRenderer.send('session:close'),
  // config + identity the moved code reads.
  getSignalingUrl: () => ipcRenderer.invoke('get-signaling-url'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setSessionActive: (active) => ipcRenderer.send('updater:set-session-active', active),
  readClipboard: () => ipcRenderer.invoke('clipboard-read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard-write', text),
  // connect-from-console device-keypair handshake crypto (runs in main).
  connAuthPublicKey: () => ipcRenderer.invoke('conn-auth:public-key'),
  connAuthDeviceId: () => ipcRenderer.invoke('conn-auth:device-id'),
  connAuthSign: (message) => ipcRenderer.invoke('conn-auth:sign', message),
  connAuthVerify: (publicKey, message, signature) => ipcRenderer.invoke('conn-auth:verify', publicKey, message, signature),
  connAuthIsAccountKey: (publicKey) => ipcRenderer.invoke('conn-auth:is-account-key', publicKey),
  // renderer log bridge (main sink).
  reportError: (entry) => ipcRenderer.send('log:renderer', entry),
  log: (entry) => ipcRenderer.send('log:renderer', entry),
});
