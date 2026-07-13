import { expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createUpdater } from '../src/updater.js';

// A fake shaped like electron-updater's autoUpdater.
function fakeUpdater() {
  const em = new EventEmitter();
  em.autoDownload = null;
  em.autoInstallOnAppQuit = null;
  em.checkForUpdates = vi.fn(() => Promise.resolve());
  em.quitAndInstall = vi.fn();
  return em;
}

test('start() is inert when not packaged', () => {
  const u = fakeUpdater();
  const onStatus = vi.fn();
  createUpdater({ updater: u, isPackaged: false, onStatus }).start();
  expect(u.checkForUpdates).not.toHaveBeenCalled();
  expect(onStatus).not.toHaveBeenCalled();
});

test('start() (packaged) configures autoUpdater and checks immediately', () => {
  const u = fakeUpdater();
  createUpdater({ updater: u, isPackaged: true, onStatus: vi.fn() }).start();
  expect(u.autoDownload).toBe(true);
  expect(u.autoInstallOnAppQuit).toBe(true);
  expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
});

test('events drive onStatus with policy-derived UI state', () => {
  const u = fakeUpdater();
  const onStatus = vi.fn();
  createUpdater({ updater: u, isPackaged: true, onStatus }).start();
  u.emit('update-available', { version: '2.0.0' });
  u.emit('update-downloaded', { version: '2.0.0' });
  const last = onStatus.mock.calls.at(-1)[0];
  expect(last).toMatchObject({ showRestartPrompt: true, version: '2.0.0', message: 'Update 2.0.0 ready to install.' });
});

test('setSessionActive suppresses the restart prompt for a downloaded update', () => {
  const u = fakeUpdater();
  const onStatus = vi.fn();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus });
  up.start();
  up.setSessionActive(true);
  u.emit('update-downloaded', { version: '2.0.0' });
  expect(onStatus.mock.calls.at(-1)[0].showRestartPrompt).toBe(false);
  up.setSessionActive(false);           // session ended → prompt re-surfaces
  expect(onStatus.mock.calls.at(-1)[0].showRestartPrompt).toBe(true);
});

test('installNow gates on downloaded + no session', () => {
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: vi.fn() });
  up.start();
  expect(up.installNow()).toEqual({ ok: false, reason: 'not-downloaded' });
  u.emit('update-downloaded', { version: '2.0.0' });
  up.setSessionActive(true);
  expect(up.installNow()).toEqual({ ok: false, reason: 'session-active' });
  up.setSessionActive(false);
  expect(up.installNow()).toEqual({ ok: true });
  expect(u.quitAndInstall).toHaveBeenCalledTimes(1);
});

test('periodic check fires on the interval', () => {
  vi.useFakeTimers();
  const u = fakeUpdater();
  createUpdater({ updater: u, isPackaged: true, onStatus: vi.fn(), intervalMs: 1000 }).start();
  expect(u.checkForUpdates).toHaveBeenCalledTimes(1);   // launch check
  vi.advanceTimersByTime(1000);
  expect(u.checkForUpdates).toHaveBeenCalledTimes(2);   // interval check
  vi.useRealTimers();
});

test('a rejected check surfaces a check-failure status, not a throw', async () => {
  const u = fakeUpdater();
  u.checkForUpdates = vi.fn(() => Promise.reject(new Error('no feed')));
  const onStatus = vi.fn();
  const log = vi.fn();
  createUpdater({ updater: u, isPackaged: true, onStatus, log }).start();
  await Promise.resolve(); await Promise.resolve();    // let the rejection settle
  expect(onStatus.mock.calls.at(-1)[0].message).toBe("Couldn't check for updates.");
  expect(log).toHaveBeenCalledWith('error', expect.stringContaining('no feed'));
});

test('an error while checking is a check-failure; an error after finding an update is a download-failure', () => {
  // Check phase: error arrives before any update-available → "couldn't check".
  const c = fakeUpdater();
  const onCheck = vi.fn();
  createUpdater({ updater: c, isPackaged: true, onStatus: onCheck }).start();
  c.emit('checking-for-update');
  c.emit('error', new Error('ENOTFOUND signal host'));
  expect(onCheck.mock.calls.at(-1)[0].message).toBe("Couldn't check for updates.");

  // Download phase: check succeeded (update-available), THEN the download errors.
  const d = fakeUpdater();
  const onDl = vi.fn();
  const log = vi.fn();
  createUpdater({ updater: d, isPackaged: true, onStatus: onDl, log }).start();
  d.emit('update-available', { version: '2.0.0' });
  d.emit('error', new Error('HTTP 404 on .exe'));
  expect(onDl.mock.calls.at(-1)[0].message).toBe('Update 2.0.0 was found, but the download failed.');
  expect(log).toHaveBeenCalledWith('error', expect.stringContaining('404'));
});
