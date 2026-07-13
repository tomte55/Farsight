// packages/controller/src/main.js
import { app, BrowserWindow, ipcMain, clipboard, dialog, shell } from 'electron';
// electron-updater is CommonJS: a named ESM import fails in the packaged app's
// ESM loader, so use the default import + destructure interop.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { createAppLogger } from '@farsight/shared/app-log';
import { parseConfig, serializeConfig, validateSignalingUrl, resolveSignalingUrl } from '@farsight/shared/config';
import { createUpdater } from '@farsight/shared/updater';
import { MAX_FILE_SIZE } from '@farsight/shared/file-transfer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Clipboard sync: the renderer polls/writes the OS clipboard via these handlers.
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.on('clipboard-write', (_e, text) => { if (typeof text === 'string' && text.length <= 100000) clipboard.writeText(text); });

// File transfer: fs/dialog access is main-process-only, like clipboard.
// pick-file returns the whole file as an ArrayBuffer (bounded to
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

let mainWindow = null;
let ctrlUpdater = null;
let log = null;   // root logger; assigned on app ready, referenced as log?.*

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
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
  mainWindow = win;
  return win;
}
app.whenReady().then(() => {
  ({ log } = createAppLogger({
    filePath: path.join(app.getPath('userData'), 'logs', 'main.log'),
    fs: nodeFs,
    dirname: path.dirname,
    isPackaged: app.isPackaged,
    env: process.env,
    mirror: app.isPackaged ? null : (line) => console.log(line),
  }));
  log.info('controller starting');

  process.on('uncaughtException', (err) => log?.error(`uncaughtException: ${err?.stack || err}`));
  process.on('unhandledRejection', (reason) => log?.error(`unhandledRejection: ${reason?.stack || reason}`));
  app.on('render-process-gone', (_e, _wc, d) => log?.error(`render-process-gone: ${d?.reason}`));
  app.on('child-process-gone', (_e, d) => log?.error(`child-process-gone: ${d?.type} ${d?.reason}`));

  ipcMain.on('log:renderer', (_e, entry) => {
    const level = ['debug', 'info', 'warn', 'error'].includes(entry?.level) ? entry.level : 'error';
    log?.child('renderer')[level](String(entry?.msg ?? ''));
  });

  createWindow();
  autoUpdater.logger = {
    info: (m) => log?.child('updater').info(String(m)),
    warn: (m) => log?.child('updater').warn(String(m)),
    error: (m) => log?.child('updater').error(String(m)),
    debug: (m) => log?.child('updater').debug(String(m)),
  };
  ctrlUpdater = createUpdater({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    log: (level, msg) => { const l = log?.child('updater'); if (l && l[level]) l[level](msg); },
    onStatus: (ui) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', ui); },
  });
  ctrlUpdater.start();
  ipcMain.handle('updater:check', () => { ctrlUpdater.checkNow(); return true; });
  ipcMain.handle('updater:install', () => ctrlUpdater.installNow());
  ipcMain.on('updater:set-session-active', (_e, active) => ctrlUpdater.setSessionActive(active));
  ipcMain.handle('open-logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
});
app.on('window-all-closed', () => { log?.info('controller quitting'); if (process.platform !== 'darwin') app.quit(); });
