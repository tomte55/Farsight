// packages/controller/src/tray-menu.js
// Pure builder for the host system-tray context menu template. main.js passes it
// to Menu.buildFromTemplate(). Kept pure so labels/wiring are unit-tested without
// a real Tray. The host id is empty until REGISTERED arrives — show a placeholder.
export function buildTrayMenuTemplate({ id, password, onShow, onQuit, updateReady, updateVersion, onRestartUpdate, onCheckUpdates, onOpenLogs, loggedIn, onSendDiagnostics }) {
  const menu = [
    { label: 'Show Farsight', click: onShow },
    { type: 'separator' },
    { label: `ID: ${id || '—'}`, enabled: false },
    { label: `Password: ${password || '—'}`, enabled: false },
    { type: 'separator' },
  ];
  if (updateReady) {
    menu.push({ label: `Restart to update (${updateVersion || ''})`, click: onRestartUpdate });
  }
  menu.push({ label: 'Check for updates', click: onCheckUpdates });
  menu.push({ label: 'Open logs folder', click: onOpenLogs });
  // Verbose diagnostic logging: only offered once an account is signed in
  // (§4.3-style consent gate) — logged-out installs have nowhere authenticated
  // to upload to, and this keeps the item from being an always-on temptation.
  if (loggedIn) {
    menu.push({ label: 'Send diagnostics to support…', click: onSendDiagnostics });
  }
  menu.push({ type: 'separator' });
  menu.push({ label: 'Quit', click: onQuit });
  return menu;
}
