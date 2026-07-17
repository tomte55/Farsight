// packages/controller/src/preload.cjs
// CommonJS because the renderer runs with sandbox: true (R-7).
const { contextBridge, ipcRenderer } = require('electron');
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
  // Received-files folder (Settings): read current, pick a new one, reset to default.
  getReceivedDir: () => ipcRenderer.invoke('received-dir:get'),
  chooseReceivedDir: () => ipcRenderer.invoke('received-dir:choose'),
  resetReceivedDir: () => ipcRenderer.invoke('received-dir:reset'),
  // "Allow this computer to be controlled" — persisted, default-on, gated
  // receiver-side (enforcement wiring lands in Task 6/7).
  getControlAllowed: () => ipcRenderer.invoke('control-allowed:get'),
  setControlAllowed: (v) => ipcRenderer.invoke('control-allowed:set', v),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  setSessionActive: (active) => ipcRenderer.send('updater:set-session-active', active),
  onUpdateStatus: (cb) => ipcRenderer.on('updater:status', (_e, ui) => cb(ui)),
  readClipboard: () => ipcRenderer.invoke('clipboard-read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard-write', text),
  reportError: (entry) => ipcRenderer.send('log:renderer', entry),
  log: (entry) => ipcRenderer.send('log:renderer', entry),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  // Verbose diagnostic logging: consent-gated, account-only upload of a
  // redaction-safe log bundle (main shows the consent dialog + does the work).
  sendDiagnostics: () => ipcRenderer.invoke('diagnostics:send'),
  // Account / saved-hosts console (SP2)
  accountStatus: () => ipcRenderer.invoke('account:status'),
  accountLogin: (input) => ipcRenderer.invoke('account:login', input),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  accountRegister: (input) => ipcRenderer.invoke('account:register', input),
  accountResendVerification: (input) => ipcRenderer.invoke('account:resend-verification', input),
  accountRequestPasswordReset: (input) => ipcRenderer.invoke('account:request-password-reset', input),
  accountFleet: () => ipcRenderer.invoke('account:fleet'),
  accountContacts: () => ipcRenderer.invoke('account:contacts'),
  accountContactAdd: (email) => ipcRenderer.invoke('account:contact-add', { email }),
  accountContactAccept: (contactId) => ipcRenderer.invoke('account:contact-accept', { contactId }),
  accountContactDecline: (contactId) => ipcRenderer.invoke('account:contact-decline', { contactId }),
  accountRequestUpdate: (input) => ipcRenderer.invoke('account:request-update', input),
  accountRevokeDevice: (deviceId) => ipcRenderer.invoke('account:revoke-device', { deviceId }),
  // connect-from-console: E2E device-keypair handshake crypto (runs in main).
  connAuthPublicKey: () => ipcRenderer.invoke('conn-auth:public-key'),
  connAuthDeviceId: () => ipcRenderer.invoke('conn-auth:device-id'),
  connAuthSign: (message) => ipcRenderer.invoke('conn-auth:sign', message),
  connAuthVerify: (publicKey, message, signature) => ipcRenderer.invoke('conn-auth:verify', publicKey, message, signature),
  connAuthIsAccountKey: (publicKey) => ipcRenderer.invoke('conn-auth:is-account-key', publicKey),
  // SP3 file transfer (send path): pick files/folders via the OS dialog, start
  // a send to a target {id,password}, list persisted jobs, best-effort cancel,
  // and subscribe to live progress pushed from main as 'transfer:event'.
  transferPickPaths: (mode) => ipcRenderer.invoke('transfer:pick-paths', mode),
  transferSend: (input) => ipcRenderer.invoke('transfer:send', input),
  transferList: () => ipcRenderer.invoke('transfer:list'),
  transferCancel: (jobId) => ipcRenderer.invoke('transfer:cancel', jobId),
  transferRemove: (jobId) => ipcRenderer.invoke('transfer:remove', jobId),
  onTransferEvent: (cb) => ipcRenderer.on('transfer:event', (_e, ev) => cb(ev)),
  // SP3 receive path (v2): the host-registration socket relays a TRANSFER_REQUEST,
  // which the renderer forwards to main; main round-trips consent (manifest preview)
  // before anything touches disk.
  transferIncoming: (input) => ipcRenderer.invoke('transfer:incoming', input),
  onTransferConsent: (cb) => ipcRenderer.on('transfer:consent-request', (_e, req) => cb(req)),
  respondConsent: (input) => ipcRenderer.send('transfer:respond-consent', input),
  // Unification step 2: the remote-control session lives in its own
  // BrowserWindow (session-window.js). The shell asks main to open/focus it
  // and listens for status/closed pushes to drive its status bar.
  openSession: (params) => ipcRenderer.send('session:open', params),
  focusSession: () => ipcRenderer.send('session:focus'),
  onSessionStatus: (cb) => ipcRenderer.on('session:status', (_e, s) => cb(s)),
  onSessionClosed: (cb) => ipcRenderer.on('session:closed', () => cb()),
});
