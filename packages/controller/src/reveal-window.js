// packages/controller/src/reveal-window.js
// Bring the controller window to the foreground. Used by the single-instance
// 'second-instance' handler: a user who relaunches the controller (thinking
// the old one isn't running) expects the existing window back — not a second
// process. Mirrors packages/host/src/reveal-window.js exactly; the controller
// has no tray, so this is only reached from 'second-instance' here. Operates
// on an injected window-like object so it's unit-tested without a BrowserWindow.
export function revealWindow(win) {
  if (!win) return;
  if (win.isMinimized && win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
