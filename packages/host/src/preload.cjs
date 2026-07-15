// packages/host/src/preload.cjs
// CommonJS because the renderer runs with sandbox: true (R-7), which requires
// sandboxed preload scripts to be CJS.
const { contextBridge, ipcRenderer } = require('electron');

// desktopCapturer/screen live in the main process; the renderer gets the
// source id via IPC (see main.js). Preload exposes only the narrow IPC
// bridge — the signaling URL is configured at runtime, not baked in.
contextBridge.exposeInMainWorld('farsightIpc', {
  getScreenSource: () => ipcRenderer.invoke('get-screen-source'),
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),
  getSessionPassword: () => ipcRenderer.invoke('get-session-password'),
  regenerateSessionPassword: () => ipcRenderer.invoke('regenerate-session-password'),
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  getScreenSourceFor: (displayId) => ipcRenderer.invoke('get-screen-source-for', displayId),
  selectInjectorDisplay: (index) => ipcRenderer.invoke('select-injector-display', index),
  injectInput: (evt) => ipcRenderer.send('inject-input', evt),
  requestAttention: () => ipcRenderer.send('request-attention'),
  setHostId: (id) => ipcRenderer.send('set-host-id', id),
  onPanic: (cb) => ipcRenderer.on('panic', () => cb()),
  onPanicUnavailable: (cb) => ipcRenderer.on('panic-unavailable', () => cb()),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getSignalingUrl: () => ipcRenderer.invoke('get-signaling-url'),
  setSignalingUrl: (url) => ipcRenderer.invoke('set-signaling-url', url),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  setSessionActive: (active) => ipcRenderer.send('updater:set-session-active', active),
  onUpdateStatus: (cb) => ipcRenderer.on('updater:status', (_e, ui) => cb(ui)),
  readClipboard: () => ipcRenderer.invoke('clipboard-read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard-write', text),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  saveFile: (arg) => ipcRenderer.invoke('save-file', arg),
  reportError: (entry) => ipcRenderer.send('log:renderer', entry),

  // Account enrollment (SP2): sign in on the host to link this machine to your
  // account (§4.3 local-login consent gate) and report presence. Mirrors the
  // controller's console bridge; all account work happens in main.
  accountStatus: () => ipcRenderer.invoke('account:status'),
  accountLogin: (input) => ipcRenderer.invoke('account:login', input),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  accountRegister: (input) => ipcRenderer.invoke('account:register', input),
  accountResendVerification: (input) => ipcRenderer.invoke('account:resend-verification', input),
  accountRequestPasswordReset: (input) => ipcRenderer.invoke('account:request-password-reset', input),
  accountFleet: () => ipcRenderer.invoke('account:fleet'),
  // connect-from-console: E2E device-keypair handshake crypto (runs in main).
  connAuthPublicKey: () => ipcRenderer.invoke('conn-auth:public-key'),
  connAuthDeviceId: () => ipcRenderer.invoke('conn-auth:device-id'),
  connAuthSign: (message) => ipcRenderer.invoke('conn-auth:sign', message),
  connAuthVerify: (publicKey, message, signature) => ipcRenderer.invoke('conn-auth:verify', publicKey, message, signature),
  connAuthIsAccountKey: (publicKey) => ipcRenderer.invoke('conn-auth:is-account-key', publicKey),
});
