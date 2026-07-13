// packages/host/src/reveal-window.js
// Bring the host window to the foreground. Used by the tray (click + "Show
// Farsight") and by the single-instance 'second-instance' handler: because the
// window hides to the tray on close, a user who re-launches the app expects the
// existing window back — not a second process with a second tray icon. Operates
// on an injected window-like object so it's unit-tested without a BrowserWindow.
export function revealWindow(win) {
  if (!win) return;
  if (win.isMinimized && win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
