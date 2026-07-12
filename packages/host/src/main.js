// packages/host/src/main.js
import { app, BrowserWindow, desktopCapturer, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInjector } from './input-injector.js';
import { createNutFacade } from './nut-facade.js';
import { registerPanicKey } from './panic.js';
import { listDisplays } from './capture.js';
import { generateSessionPassword } from '@farsight/shared/password';
import { windowAttentionPlan } from './window-attention.js';
import { buildTrayMenuTemplate } from './tray-menu.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl } from '@farsight/shared/config';
// electron-updater is CommonJS: a named ESM import fails in the packaged app's
// ESM loader, so use the default import + destructure interop.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { createUpdater } from '@farsight/shared/updater';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let tray = null;
let hostId = '';
let quitting = false;
let hostUpdater = null;
let latestUpdateUi = { showRestartPrompt: false, checking: false, message: '', version: null };
// 16×16 Aurora gradient PNG (violet→blue, rounded). Inline data URL so the tray
// needs no external icon asset (packaging-safe).
const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmUlEQVR4nKXT4QrBYBiG4ef4RCKRLKyxsLCwsEitpKSkpKSkpJzlLXIE33sA189LKw+lLbT0Yd6BJIRZHyYRxCMYxzCcQpTAYAG9FMI1dDcoyJArJsjA3yILpr0DWXBzD7Jg7wCy4MYRZMH1E8iCa2eQBVcvIAuuXEEWXL6BLLh0B1lw8QGy4MIT9F/lhPMv9Cv5XeWCc2/0AR9g1yt6gn/UAAAAAElFTkSuQmCC';

// Per-launch session password. Generated in the trusted main process (node:crypto)
// and handed to the renderer via IPC — the sandboxed renderer can't run node:crypto.
const sessionPassword = generateSessionPassword();

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
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Attended-access: the app must keep running to receive connections, so
  // closing the window hides it to the tray instead of quitting. A real quit
  // (tray Quit) sets `quitting` first.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  mainWindow = win;
  return win;
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
    id: hostId,
    password: sessionPassword,
    onShow: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    onQuit: () => { quitting = true; app.quit(); },
    updateReady: latestUpdateUi.showRestartPrompt,
    updateVersion: latestUpdateUi.version,
    onRestartUpdate: () => hostUpdater && hostUpdater.installNow(),
    onCheckUpdates: () => hostUpdater && hostUpdater.checkNow(),
  })));
}

function createTray() {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('Farsight Host');
  tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  refreshTrayMenu();
}

// Bring the window to attention when a controller asks to connect. The renderer
// forwards CONNECT via 'request-attention'; we apply the pure windowAttentionPlan.
ipcMain.on('request-attention', () => {
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
ipcMain.on('set-host-id', (_e, id) => { hostId = String(id || ''); refreshTrayMenu(); });

// Provide the primary screen source id to the renderer on request.
ipcMain.handle('get-screen-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const primaryId = screen.getPrimaryDisplay().id;
  const src = sources.find((s) => String(s.display_id) === String(primaryId)) ?? sources[0];
  return src ? src.id : null;
});

ipcMain.handle('get-screen-size', () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  return { width, height };
});

// The renderer displays the session password and sends it on REGISTER.
ipcMain.handle('get-session-password', () => sessionPassword);

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
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const s = sources.find((x) => String(x.display_id) === String(displayId));
  return s ? s.id : (sources[0] ? sources[0].id : null);
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

// Auto-update: the renderer can trigger a manual check/install, and reports
// whether a remote-control session is active so we never install mid-session.
ipcMain.handle('updater:check', () => { if (hostUpdater) hostUpdater.checkNow(); return true; });
ipcMain.handle('updater:install', () => hostUpdater ? hostUpdater.installNow() : { ok: false, reason: 'not-downloaded' });
ipcMain.on('updater:set-session-active', (_e, active) => { if (hostUpdater) hostUpdater.setSessionActive(active); });

app.whenReady().then(() => {
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
    if (mainWindow) mainWindow.webContents.send('panic');
  });
  if (!panicOk) {
    console.warn('[panic] Failed to register Ctrl+Alt+F12 — another app may own it. The instant-kill override is NOT active.');
    mainWindow.webContents.on('did-finish-load', () => {
      if (mainWindow) mainWindow.webContents.send('panic-unavailable');
    });
  }

  hostUpdater = createUpdater({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    onStatus: (ui) => {
      latestUpdateUi = ui;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', ui);
      refreshTrayMenu();
    },
  });
  hostUpdater.start();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (quitting && process.platform !== 'darwin') app.quit(); });
