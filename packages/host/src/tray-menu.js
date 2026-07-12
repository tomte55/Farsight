// packages/host/src/tray-menu.js
// Pure builder for the host system-tray context menu template. main.js passes it
// to Menu.buildFromTemplate(). Kept pure so labels/wiring are unit-tested without
// a real Tray. The host id is empty until REGISTERED arrives — show a placeholder.
export function buildTrayMenuTemplate({ id, password, onShow, onQuit, updateReady, updateVersion, onRestartUpdate, onCheckUpdates }) {
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
  menu.push({ type: 'separator' });
  menu.push({ label: 'Quit', click: onQuit });
  return menu;
}
