// packages/host/src/tray-menu.js
// Pure builder for the host system-tray context menu template. main.js passes it
// to Menu.buildFromTemplate(). Kept pure so labels/wiring are unit-tested without
// a real Tray. The host id is empty until REGISTERED arrives — show a placeholder.
export function buildTrayMenuTemplate({ id, password, onShow, onQuit }) {
  return [
    { label: 'Show Farsight', click: onShow },
    { type: 'separator' },
    { label: `ID: ${id || '—'}`, enabled: false },
    { label: `Password: ${password || '—'}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: onQuit },
  ];
}
