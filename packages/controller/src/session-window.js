// packages/controller/src/session-window.js
// Main-process owner of the VISIBLE remote-control session window (unification
// step 2). The session used to take over the shell's main window; it now lives
// here, in its own BrowserWindow, so the shell keeps working underneath and a
// session can be full-screened / thrown on a second monitor. Mirrors the hidden
// transfer-worker window's lifecycle discipline (queue-until-did-finish-load,
// listener tracking, explicit close) — the proven pattern for a second window
// that owns its own peer connection + signaling.
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { revealWindow } from './reveal-window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createSessionWindow({ onStatus = () => {}, onClosed = () => {}, onLog = () => {} } = {}) {
  let win = null;
  let rendererReady = false;
  const preReadyQueue = [];
  const registeredListeners = [];

  function onIpc(topic, handler) {
    ipcMain.on(topic, handler);
    registeredListeners.push([topic, handler]);
  }

  function sendToRenderer(topic, payload) {
    if (!win || win.isDestroyed()) return;
    if (!rendererReady) { preReadyQueue.push([topic, payload]); return; }
    win.webContents.send(topic, payload);
  }

  function create() {
    win = new BrowserWindow({
      width: 1280, height: 800,
      // Its own visible window — full-screenable, second-monitor-able.
      webPreferences: {
        preload: path.join(__dirname, 'session-window-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // R-7: defense in depth
        // The session renderer owns input capture and the peer connection; a
        // covered/minimized window drops to Windows Idle priority and starves
        // input (v1.14.2: 4084ms avg latency, 26% of events lost). Non-negotiable.
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
    win.loadFile(path.join(__dirname, 'session-window', 'index.html'));

    rendererReady = false;
    win.webContents.on('did-finish-load', () => {
      rendererReady = true;
      for (const [topic, payload] of preReadyQueue) {
        if (win && !win.isDestroyed()) win.webContents.send(topic, payload);
      }
      preReadyQueue.length = 0;
    });

    // The user closing the session window ends the session (like clicking
    // Disconnect). The shell learns via onClosed and clears its status bar.
    win.on('closed', () => { win = null; rendererReady = false; preReadyQueue.length = 0; onClosed(); });
  }

  // session:status and session:closed come FROM the renderer. Registered once,
  // for the factory's life; the payload is forwarded to the shell by main.js.
  onIpc('session:status', (_e, status) => onStatus(status));
  onIpc('session:log', (_e, obj) => onLog(obj));
  // The session renderer asks to close the window when a session ends (its
  // doClose — End button, overlay "Close session", host-ended). Closing the
  // window (not the factory) triggers win.on('closed') → onClosed exactly like
  // the user closing it manually, so the shell clears its status bar and a later
  // session:open recreates a fresh window. Without this, doClose only hid the
  // video/overlay and left an open, empty window that never went away.
  onIpc('session:close', () => { if (win && !win.isDestroyed()) win.close(); });

  return {
    isOpen: () => !!win && !win.isDestroyed(),
    launch(params) {
      if (!win || win.isDestroyed()) create();
      else revealWindow(win);
      sendToRenderer('session:launch', params);
    },
    focus() { if (win && !win.isDestroyed()) revealWindow(win); },
    close() {
      for (const [topic, handler] of registeredListeners) ipcMain.removeListener(topic, handler);
      registeredListeners.length = 0;
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
