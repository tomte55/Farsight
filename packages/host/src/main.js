// packages/host/src/main.js
import { app, BrowserWindow, desktopCapturer, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage, clipboard, dialog, shell, safeStorage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInjector } from './input-injector.js';
import { createNutFacade } from './nut-facade.js';
import { registerPanicKey } from './panic.js';
import { listDisplays } from './capture.js';
import { generateSessionPassword } from '@farsight/shared/password';
import { windowAttentionPlan } from './window-attention.js';
import { buildTrayMenuTemplate } from './tray-menu.js';
import { createLifecycle } from './lifecycle.js';
import { revealWindow } from './reveal-window.js';
import { readFileSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { createAppLogger } from '@farsight/shared/app-log';
import { parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl } from '@farsight/shared/config';
import { MAX_FILE_SIZE } from '@farsight/shared/file-transfer';
// electron-updater is CommonJS: a named ESM import fails in the packaged app's
// ESM loader, so use the default import + destructure interop.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { createUpdater } from '@farsight/shared/updater';
import { shouldConverge } from '@farsight/shared/update-policy';
import { createAccountService, DEFAULT_ACCOUNT_URL } from '@farsight/shared/account-service';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Account service (SP2 enrollment) — lazily built so safeStorage / app.getPath
// are ready. Signing in on the host links it as a Device under the owner's
// account (§4.3: local login is the consent gate) and heartbeats presence so it
// shows online + versioned in the controller's fleet console. The refresh token
// is stored encrypted under userData; the account URL defaults to the deployed
// service (env-overridable for dev). deviceName defaults to the machine hostname
// so the console labels this host by its machine name.
let accountService = null;
function getAccountService() {
  if (!accountService) {
    accountService = createAccountService({
      baseUrl: process.env.FARSIGHT_ACCOUNT_URL || DEFAULT_ACCOUNT_URL,
      safeStorage,
      fs: nodeFs,
      filePath: path.join(app.getPath('userData'), 'account-token.enc'),
      deviceKeyFilePath: path.join(app.getPath('userData'), 'device-key.enc'),
      fetch: globalThis.fetch,
      version: app.getVersion(),
    });
  }
  return accountService;
}
// Connect-from-console (SP2 §4.4): main-only device-keypair crypto for the E2E
// handshake, bridged to the renderer that drives the WebRTC 'auth' channel.
ipcMain.handle('conn-auth:public-key', () => getAccountService().getPublicKey());
ipcMain.handle('conn-auth:device-id', () => getAccountService().getDeviceId());
ipcMain.handle('conn-auth:sign', (_e, message) => getAccountService().signTranscript(message));
ipcMain.handle('conn-auth:verify', (_e, publicKey, message, signature) => getAccountService().verifyTranscript(publicKey, message, signature));
ipcMain.handle('conn-auth:is-account-key', (_e, publicKey) => getAccountService().isAccountPublicKey(publicKey));
ipcMain.handle('account:status', () => getAccountService().status());
ipcMain.handle('account:login', (_e, input) => getAccountService().login({ deviceName: os.hostname(), ...input }));
ipcMain.handle('account:logout', () => getAccountService().logout());
ipcMain.handle('account:register', (_e, input) => getAccountService().register(input));
ipcMain.handle('account:resend-verification', (_e, input) => getAccountService().resendVerification(input));
ipcMain.handle('account:request-password-reset', (_e, input) => getAccountService().requestPasswordReset(input));
ipcMain.handle('account:fleet', () => getAccountService().fleet());
let mainWindow = null;
let tray = null;
let hostId = '';
// Centralizes the "is the app really quitting?" latch shared by the window
// close-guard and every quit path (tray Quit, auto-update install).
const lifecycle = createLifecycle();
let hostUpdater = null;
let lastHandledTarget = null; // S2.7: the last remote-update target we acted on
let latestUpdateUi = { showRestartPrompt: false, checking: false, message: '', version: null };
let log = null;   // root logger; assigned on app ready, referenced as log?.*
// 16×16 Aurora gradient PNG (violet→blue, rounded). Inline data URL so the tray
// needs no external icon asset (packaging-safe).
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmUlEQVR4nKXT4QrBYBiG4ef4RCKRLKyxsLCwsEitpKSkpKSkpJzlLXIE33sA189LKw+lLbT0Yd6BJIRZHyYRxCMYxzCcQpTAYAG9FMI1dDcoyJArJsjA3yILpr0DWXBzD7Jg7wCy4MYRZMH1E8iCa2eQBVcvIAuuXEEWXL6BLLh0B1lw8QGy4MIT9F/lhPMv9Cv5XeWCc2/0AR9g1yt6gn/UAAAAAElFTkSuQmCC';

// Per-launch session password. Generated in the trusted main process (node:crypto)
// and handed to the renderer via IPC — the sandboxed renderer can't run node:crypto.
let sessionPassword = generateSessionPassword();

// Input injection uses nut.js, a native Node addon that cannot load in the
// sandboxed renderer. The renderer forwards validated-shape input events over
// IPC; we validate (inside the injector) and inject here in the main process.
// The injector is display-aware: fractional [0,1] coords map into the selected
// display's DIP bounds, then through screen.dipToScreenPoint to physical pixels
// (correct on scaled/secondary monitors). It starts on the primary display and
// follows the controller's monitor selection via 'select-injector-display'.
let injector = null;
function getInjector() {
  if (!injector) {
    const displays = listDisplays(screen);
    const primary = displays.find((d) => d.primary) ?? displays[0];
    injector = createInjector({
      nut: createNutFacade(),
      display: primary,
      dipToScreen: (p) => screen.dipToScreenPoint(p),
    });
  }
  return injector;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 520,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // R-7: defense in depth
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Attended-access: the app must keep running to receive connections, so
  // closing the window hides it to the tray instead of quitting. A real quit
  // (from any path) latches lifecycle.beginQuit() via app 'before-quit' first,
  // so shouldHideOnClose() returns false and the window is allowed to close.
  win.on('close', (e) => {
    if (lifecycle.shouldHideOnClose()) { e.preventDefault(); win.hide(); }
  });
  mainWindow = win;
  return win;
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
    id: hostId,
    password: sessionPassword,
    onShow: () => revealWindow(mainWindow),
    onQuit: () => { lifecycle.beginQuit(); app.quit(); },
    updateReady: latestUpdateUi.showRestartPrompt,
    updateVersion: latestUpdateUi.version,
    onRestartUpdate: () => hostUpdater && hostUpdater.installNow(),
    onCheckUpdates: () => hostUpdater && hostUpdater.checkNow(),
    onOpenLogs: () => shell.openPath(path.join(app.getPath('userData'), 'logs')),
  })));
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('Farsight Host');
  tray.on('click', () => revealWindow(mainWindow));
  refreshTrayMenu();
}

// Bring the window to attention when a controller asks to connect. The renderer
// forwards CONNECT via 'request-attention'; we apply the pure windowAttentionPlan.
ipcMain.on('request-attention', () => {
  log?.child('session').info('attention requested by incoming connection');
  const win = mainWindow;
  if (!win) return;
  const plan = windowAttentionPlan({
    isMinimized: win.isMinimized(),
    isVisible: win.isVisible(),
    isFocused: win.isFocused(),
  });
  if (plan.show) win.show();
  if (plan.restore) win.restore();
  if (plan.raiseTemporarily) { win.setAlwaysOnTop(true); setTimeout(() => win.setAlwaysOnTop(false), 1500); }
  if (plan.focus) { win.moveTop(); win.focus(); }
  if (plan.flash) win.flashFrame(true);
});

// The renderer reports its registered id so the tray can display it.
ipcMain.on('set-host-id', (_e, id) => { hostId = String(id || ''); getAccountService().setSignalingId(hostId); log?.child('session').info('host id registered'); refreshTrayMenu(); });

// Provide the primary screen source id to the renderer on request.
ipcMain.handle('get-screen-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const primaryId = screen.getPrimaryDisplay().id;
    const src = sources.find((s) => String(s.display_id) === String(primaryId)) ?? sources[0];
    return src ? src.id : null;
  } catch (err) {
    log?.child('ipc').warn(`screen-source failed: ${err.message}`);
    return null;
  }
});

ipcMain.handle('get-screen-size', () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { width, height };
});

// The renderer displays the session password and sends it on REGISTER.
ipcMain.handle('get-session-password', () => sessionPassword);

// Rotate the session password on demand (renderer's manual button or idle
// timer). Regenerate in the trusted main process, refresh the tray label, and
// return the new value so the renderer can display it and push UPDATE_PASSWORD.
ipcMain.handle('regenerate-session-password', () => {
  sessionPassword = generateSessionPassword();
  refreshTrayMenu();
  return sessionPassword;
});

// Build version for the subtle bottom-left label; app.getVersion() reads the
// packaged package.json version (set from the git tag by the release CI).
ipcMain.handle('get-app-version', () => app.getVersion());

// Signaling-server config: persisted per-user in userData/config.json (0600).
// The renderer reads/writes it via IPC; env FARSIGHT_SIGNALING_URL overrides.
function configFilePath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function readStoredConfig() {
  try { return parseConfig(readFileSync(configFilePath(), 'utf8')); }
  catch { return {}; }
}
ipcMain.handle('get-signaling-url', () => {
  const stored = readStoredConfig();
  return resolveSignalingUrl({
    envUrl: process.env.FARSIGHT_SIGNALING_URL,
    storedUrl: stored.signalingUrl,
  }).url;
});
ipcMain.handle('set-signaling-url', (_e, url) => {
  try {
    const normalized = validateSignalingUrl(url);
    writeFileSync(configFilePath(), serializeConfig({ signalingUrl: normalized }), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, url: normalized };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Enumerate all monitors so the renderer can offer a picker and capture a
// specific display.
ipcMain.handle('list-displays', () => listDisplays(screen));

// Resolve the desktopCapturer source id for a given display id (monitor switch).
ipcMain.handle('get-screen-source-for', async (_e, displayId) => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const s = sources.find((x) => String(x.display_id) === String(displayId));
    return s ? s.id : (sources[0] ? sources[0].id : null);
  } catch (err) {
    log?.child('ipc').warn(`screen-source failed: ${err.message}`);
    return null;
  }
});

// Point the main-process injector at the selected monitor's DIP bounds so
// input maps into that display's region.
ipcMain.handle('select-injector-display', (_e, index) => {
  const d = listDisplays(screen)[index];
  if (d) getInjector().setDisplay(d);
});

// Inject an input event received over the WebRTC data channel. Fire-and-forget
// (ipcRenderer.send) so high-frequency mouse moves don't await a round trip.
// The injector validates every event before it reaches nut.js.
ipcMain.on('inject-input', (_e, evt) => { getInjector().inject(evt); });

// Clipboard sync: the renderer polls/writes the OS clipboard via these handlers
// (native clipboard access is main-process-only, like nut.js input injection).
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.on('clipboard-write', (_e, text) => { if (typeof text === 'string' && text.length <= 100000) clipboard.writeText(text); });

// File transfer: fs/dialog access is main-process-only, like clipboard and
// nut.js. pick-file returns the whole file as an ArrayBuffer (bounded to
// MAX_FILE_SIZE) for the renderer to chunk and send over the 'file' data
// channel; save-file always goes through a user-driven Save dialog, and only
// ever uses the basename of the (already-sanitized-by-caller) name.
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  let buf;
  try { buf = readFileSync(p); } catch (err) { log?.child('ipc').warn(`pick-file read failed: ${err.message}`); return { error: err.message }; }
  if (buf.length > MAX_FILE_SIZE) { log?.child('ipc').info('pick-file rejected: over size limit'); return { error: 'File is larger than the 100 MB transfer limit.' }; }
  return { name: path.basename(p), size: buf.length, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
});
ipcMain.handle('save-file', async (_e, arg) => {
  const { name, bytes } = arg || {};
  if (!(bytes instanceof ArrayBuffer)) return { ok: false };
  const r = await dialog.showSaveDialog({ defaultPath: path.basename(String(name || 'download')) });
  if (r.canceled || !r.filePath) return { ok: false };
  try { writeFileSync(r.filePath, Buffer.from(bytes)); return { ok: true }; }
  catch (err) { log?.child('ipc').warn(`save-file write failed: ${err.message}`); return { ok: false, error: err.message }; }
});

// Auto-update: the renderer can trigger a manual check/install, and reports
// whether a remote-control session is active so we never install mid-session.
ipcMain.handle('updater:check', () => { if (hostUpdater) hostUpdater.checkNow(); return true; });
ipcMain.handle('updater:install', () => hostUpdater ? hostUpdater.installNow() : { ok: false, reason: 'not-downloaded' });
ipcMain.on('updater:set-session-active', (_e, active) => { if (hostUpdater) hostUpdater.setSessionActive(active); });

// Single-instance lock: because the window hides to the tray on close, the app
// looks "closed" while still running — so re-launching it (or the auto-updater
// relaunching after an install) would otherwise spawn a SECOND process with its
// own tray icon. The first launch owns the lock; any later launch hands off via
// 'second-instance' to reveal the running window, then exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
app.on('second-instance', () => revealWindow(mainWindow));
// Any genuine quit — tray "Quit", autoUpdater.quitAndInstall(), or the
// autoInstallOnAppQuit fallback — routes through app 'before-quit', which
// latches quitting BEFORE the window gets its 'close' event. Without this the
// close-guard preventDefaults the quit, the process stays alive, and the update
// installer can't shut the running app down.
app.on('before-quit', () => lifecycle.beginQuit());

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;   // losing instance: never create a window/tray
  ({ log } = createAppLogger({
    filePath: path.join(app.getPath('userData'), 'logs', 'main.log'),
    fs: nodeFs,
    dirname: path.dirname,
    isPackaged: app.isPackaged,
    env: process.env,
    mirror: app.isPackaged ? null : (line) => console.log(line),
  }));
  log.info('host starting');

  process.on('uncaughtException', (err) => log?.error(`uncaughtException: ${err?.stack || err}`));
  process.on('unhandledRejection', (reason) => log?.error(`unhandledRejection: ${reason?.stack || reason}`));
  app.on('render-process-gone', (_e, _wc, d) => log?.error(`render-process-gone: ${d?.reason}`));
  app.on('child-process-gone', (_e, d) => log?.error(`child-process-gone: ${d?.type} ${d?.reason}`));

  ipcMain.on('log:renderer', (_e, entry) => {
    const level = ['debug', 'info', 'warn', 'error'].includes(entry?.level) ? entry.level : 'error';
    log?.child('renderer')[level](String(entry?.msg ?? ''));
  });

  createWindow();
  createTray();
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  // Panic hotkey: a physical override that instantly kills any session.
  // globalShortcut.register fails silently if another app already owns the
  // accelerator, leaving the documented instant-kill override inactive — warn
  // in the console and surface it visibly in the renderer. did-finish-load is
  // attached synchronously here (before the async loadFile navigation
  // triggered in createWindow can complete), so it cannot fire before this
  // listener is registered; the renderer's own onPanicUnavailable listener is
  // wired up before its first await, so it is guaranteed to be registered by
  // the time did-finish-load fires.
  const panicOk = registerPanicKey(globalShortcut, 'CommandOrControl+Alt+F12', () => {
    log?.child('session').warn('panic hotkey fired — killing session');
    if (mainWindow) mainWindow.webContents.send('panic');
  });
  if (!panicOk) {
    console.warn('[panic] Failed to register Ctrl+Alt+F12 — another app may own it. The instant-kill override is NOT active.');
    log?.child('session').warn('panic hotkey unavailable — another app owns Ctrl+Alt+F12');
    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow) mainWindow.webContents.send('panic-unavailable');
    });
  }

  autoUpdater.logger = {
    info: (m) => log?.child('updater').info(String(m)),
    warn: (m) => log?.child('updater').warn(String(m)),
    error: (m) => log?.child('updater').error(String(m)),
    debug: (m) => log?.child('updater').debug(String(m)),
  };
  hostUpdater = createUpdater({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    log: (level, msg) => { const l = log?.child('updater'); if (l && l[level]) l[level](msg); },
    onStatus: (ui) => {
      latestUpdateUi = ui;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', ui);
      refreshTrayMenu();
    },
  });
  hostUpdater.start();

  // Remote update (S2.7): act on a converge-to directive delivered via the account
  // heartbeat. Only when the target is strictly newer than us, and only once per
  // target (installWhenReady checks/downloads then installs — deferring across an
  // active session). Installs ONLY the official feed release; the directive is just
  // a version string. Registered here so a linked host that resumed its session on
  // launch converges without any UI.
  getAccountService().onUpdateDirective((data) => {
    const target = data && typeof data.targetVersion === 'string' ? data.targetVersion : null;
    if (target && target !== lastHandledTarget && shouldConverge({ currentVersion: app.getVersion(), targetVersion: target })) {
      lastHandledTarget = target;
      log?.child('updater').info(`remote update directive → converge to ${target}`);
      if (hostUpdater) hostUpdater.installWhenReady();
    }
  });
});
app.on('will-quit', () => { log?.info('host quitting'); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (lifecycle.isQuitting() && process.platform !== 'darwin') app.quit(); });
