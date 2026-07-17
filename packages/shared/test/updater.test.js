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

test('installWhenReady installs immediately when already downloaded (no session)', () => {
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: vi.fn() });
  up.start();
  u.emit('update-downloaded', { version: '2.0.0' });
  expect(up.installWhenReady()).toEqual({ ok: true });
  expect(u.quitAndInstall).toHaveBeenCalledTimes(1);
});

test('installWhenReady triggers a check then installs when the download completes', () => {
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: vi.fn() });
  up.start();
  u.checkForUpdates.mockClear();
  const res = up.installWhenReady();               // not downloaded yet
  expect(res).toEqual({ ok: true, pending: true });
  expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(u.quitAndInstall).not.toHaveBeenCalled();
  u.emit('update-downloaded', { version: '2.0.0' }); // download finishes → install
  expect(u.quitAndInstall).toHaveBeenCalledTimes(1);
});

test('installWhenReady defers across an active session, installs on session end', () => {
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: vi.fn() });
  up.start();
  up.setSessionActive(true);
  up.installWhenReady();
  u.emit('update-downloaded', { version: '2.0.0' });
  expect(u.quitAndInstall).not.toHaveBeenCalled();   // deferred: session active
  up.setSessionActive(false);
  expect(u.quitAndInstall).toHaveBeenCalledTimes(1);  // applies on session end
});

test('installWhenReady is inert when not packaged', () => {
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: false, onStatus: vi.fn() });
  up.start();
  expect(up.installWhenReady()).toEqual({ ok: false, reason: 'not-packaged' });
  expect(u.quitAndInstall).not.toHaveBeenCalled();
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

test('a forced (remote) install is SILENT and ALWAYS relaunches', () => {
  // quitAndInstall(true) alone would leave isForceRunAfter=false and the host
  // would install and never come back — the exact bug seen in the field.
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: () => {} });
  up.start();
  u.emit('update-downloaded', { version: '1.14.0' });
  up.installWhenReady({ force: true });
  expect(u.quitAndInstall).toHaveBeenCalledWith(true, true); // silent + force-run
});

test('a forced install overrides an ACTIVE session (the owner asked for it)', () => {
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: () => {} });
  up.start();
  up.setSessionActive(true);
  u.emit('update-downloaded', { version: '1.14.0' });
  up.installWhenReady({ force: true });
  expect(u.quitAndInstall).toHaveBeenCalledWith(true, true); // installed despite the live session
});

test('the tray install stays VISIBLE and relaunches (no args = autoRunAppAfterInstall)', () => {
  // Someone is at the machine; the progress window is reassuring. quitAndInstall()
  // with no args relaunches via autoRunAppAfterInstall (default true).
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: () => {} });
  up.start();
  u.emit('update-downloaded', { version: '1.14.0' });
  up.installNow();
  expect(u.quitAndInstall).toHaveBeenCalledWith(); // no arguments
});

test('a forced install still waits for the download, then installs silently on ready', () => {
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: () => {} });
  up.start();
  up.installWhenReady({ force: true });      // nothing downloaded yet
  expect(u.quitAndInstall).not.toHaveBeenCalled();
  u.emit('update-downloaded', { version: '1.14.0' });
  expect(u.quitAndInstall).toHaveBeenCalledWith(true, true); // force survived the wait
});

test('an UNforced installWhenReady still defers across an active session', () => {
  // Regression guard: only the explicit remote directive overrides the guard.
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: () => {} });
  up.start();
  up.setSessionActive(true);
  u.emit('update-downloaded', { version: '1.14.0' });
  up.installWhenReady();
  expect(u.quitAndInstall).not.toHaveBeenCalled();
  up.setSessionActive(false);
  expect(u.quitAndInstall).toHaveBeenCalledTimes(1);
});

test('a FAILED forced download does not leave a later background update forced', () => {
  // The force means "install what I asked for, now". Once the attempt fails that
  // intent is stale: a later background download must install politely (deferring
  // across a live session), not kill the owner's session days later.
  const u = fakeUpdater();
  const up = createUpdater({ updater: u, isPackaged: true, onStatus: () => {} });
  up.start();
  up.installWhenReady({ force: true });        // owner presses Update
  u.emit('update-available', { version: '1.14.0' });
  u.emit('error', new Error('download failed')); // the forced attempt dies
  // Days later: a real session is live, and the background check finds a version.
  up.setSessionActive(true);
  u.emit('update-downloaded', { version: '1.15.0' });
  expect(u.quitAndInstall).not.toHaveBeenCalled();  // deferred, session intact
  up.setSessionActive(false);
  expect(u.quitAndInstall).toHaveBeenCalledTimes(1); // and it lands politely on session end
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
