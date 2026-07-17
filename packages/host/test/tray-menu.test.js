// packages/host/test/tray-menu.test.js
import { expect, test, vi } from 'vitest';
import { buildTrayMenuTemplate } from '../src/tray-menu.js';

test('builds Show / credentials / Quit with wired callbacks', () => {
  const onShow = vi.fn();
  const onQuit = vi.fn();
  const onCheckUpdates = vi.fn();
  const onOpenLogs = vi.fn();
  const t = buildTrayMenuTemplate({ id: '410 682 937', password: 'k7m2-9xqp-4vwt', onShow, onQuit, updateReady: false, onRestartUpdate(){}, onCheckUpdates, onOpenLogs });

  const labels = t.map((i) => i.label).filter(Boolean);
  expect(labels).toEqual([
    'Show Farsight',
    'ID: 410 682 937',
    'Password: k7m2-9xqp-4vwt',
    'Check for updates',
    'Open logs folder',
    'Quit',
  ]);

  // Credential rows are display-only.
  expect(t.find((i) => i.label === 'ID: 410 682 937').enabled).toBe(false);
  expect(t.find((i) => i.label === 'Password: k7m2-9xqp-4vwt').enabled).toBe(false);

  // Separators present between groups (unchanged at 3).
  expect(t.filter((i) => i.type === 'separator').length).toBe(3);

  t.find((i) => i.label === 'Show Farsight').click();
  t.find((i) => i.label === 'Quit').click();
  expect(onShow).toHaveBeenCalledOnce();
  expect(onQuit).toHaveBeenCalledOnce();

  t.find((i) => i.label === 'Open logs folder').click();
  expect(onOpenLogs).toHaveBeenCalledOnce();
});

test('shows placeholders before the id is registered', () => {
  const t = buildTrayMenuTemplate({ id: '', password: 'k7m2-9xqp-4vwt', onShow() {}, onQuit() {} });
  expect(t.find((i) => i.label && i.label.startsWith('ID:')).label).toBe('ID: —');
});

test('adds a Restart-to-update item only when an update is ready', () => {
  const withUpdate = buildTrayMenuTemplate({ id: '1', password: 'p', onShow(){}, onQuit(){}, updateReady: true, updateVersion: '1.2.0', onRestartUpdate(){}, onCheckUpdates(){} });
  expect(withUpdate.some(i => i.label === 'Restart to update (1.2.0)')).toBe(true);

  const noUpdate = buildTrayMenuTemplate({ id: '1', password: 'p', onShow(){}, onQuit(){}, updateReady: false, onRestartUpdate(){}, onCheckUpdates(){} });
  expect(noUpdate.some(i => typeof i.label === 'string' && i.label.startsWith('Restart to update'))).toBe(false);
});

test('the Restart-to-update item is still shown and wired while a session is active', () => {
  // main.js derives `updateReady` from updateUiState({...}).showRestartPrompt,
  // which (per update-policy.js) is now true whenever a download is ready
  // regardless of sessionActive — the tray menu itself doesn't know about
  // sessions, but this pins the caller-visible contract: an active session
  // must never cause `updateReady` to hide the item. Field bug: the owner was
  // remote-controlling the host and the item was missing when they needed it.
  const onRestartUpdate = vi.fn();
  const t = buildTrayMenuTemplate({
    id: '1', password: 'p', onShow(){}, onQuit(){},
    updateReady: true, updateVersion: '1.14.1',
    onRestartUpdate, onCheckUpdates(){},
  });
  const item = t.find(i => i.label === 'Restart to update (1.14.1)');
  expect(item).toBeTruthy();
  item.click();
  expect(onRestartUpdate).toHaveBeenCalledOnce();
});

test('always offers a Check-for-updates item', () => {
  const t = buildTrayMenuTemplate({ id: '1', password: 'p', onShow(){}, onQuit(){}, updateReady: false, onRestartUpdate(){}, onCheckUpdates(){} });
  expect(t.some(i => i.label === 'Check for updates')).toBe(true);
});

test('adds a Send-diagnostics item only when logged in', () => {
  const onSendDiagnostics = vi.fn();
  const loggedOut = buildTrayMenuTemplate({ id: '1', password: 'p', onShow(){}, onQuit(){}, onCheckUpdates(){}, onOpenLogs(){}, loggedIn: false, onSendDiagnostics });
  expect(loggedOut.some(i => i.label === 'Send diagnostics to support…')).toBe(false);

  const loggedIn = buildTrayMenuTemplate({ id: '1', password: 'p', onShow(){}, onQuit(){}, onCheckUpdates(){}, onOpenLogs(){}, loggedIn: true, onSendDiagnostics });
  const item = loggedIn.find(i => i.label === 'Send diagnostics to support…');
  expect(item).toBeTruthy();
  item.click();
  expect(onSendDiagnostics).toHaveBeenCalledOnce();
});
