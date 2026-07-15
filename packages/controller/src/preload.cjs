// packages/controller/src/preload.cjs
// CommonJS because the renderer runs with sandbox: true (R-7).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('farsightIpc', {
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
  openLogs: () => ipcRenderer.invoke('open-logs'),
  // Account / saved-hosts console (SP2)
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
