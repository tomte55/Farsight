// packages/controller/test/session-close-wiring.test.js
// Guard: ending a session must actually CLOSE the session BrowserWindow, not just
// hide its contents. doClose() used to tear down the peer + hide the video/overlay
// and stop there, leaving an open, empty window that never went away. The fix is a
// session:close IPC (renderer doClose → main → win.close()), which triggers the
// same win.on('closed') path as the user closing it manually.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionWindow = readFileSync(resolve(__dirname, '../src/session-window.js'), 'utf8');
const sessionPreload = readFileSync(resolve(__dirname, '../src/session-window-preload.cjs'), 'utf8');
const sessionRenderer = readFileSync(resolve(__dirname, '../src/session-window/session.js'), 'utf8');

describe('session window closes on end/disconnect', () => {
  test('the session-window factory handles session:close by closing the window', () => {
    expect(sessionWindow).toContain("'session:close'");
    // The handler must close/destroy the actual window, not merely null a ref.
    const idx = sessionWindow.indexOf("'session:close'");
    const handler = sessionWindow.slice(idx, idx + 200);
    expect(handler).toMatch(/win\.(close|destroy)\(\)/);
  });

  test('the session preload exposes a close bridge to the renderer', () => {
    expect(sessionPreload).toMatch(/close:\s*\(\)\s*=>\s*ipcRenderer\.send\('session:close'\)/);
  });

  test('doClose asks main to close the window after tearing the session down', () => {
    const fn = sessionRenderer.slice(sessionRenderer.indexOf('function doClose('), sessionRenderer.indexOf('function doReconnect('));
    expect(fn).toContain('farsightSession.close(');
  });
});
