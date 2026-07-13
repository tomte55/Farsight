// packages/controller/src/renderer/error-reporter.js
// Forwards uncaught renderer errors to the main-process log (userData/logs).
// Loaded before renderer.js so boot-time errors are captured too. Never forwards
// payloads — only error text, truncated again on the main side.
(() => {
  const report = (level, msg) => {
    try { window.farsightIpc?.reportError({ level, msg: String(msg).slice(0, 2000) }); } catch {}
  };
  window.addEventListener('error', (e) => report('error', e?.error?.stack || e?.message || 'window error'));
  window.addEventListener('unhandledrejection', (e) => report('error', `unhandledrejection: ${e?.reason?.stack || e?.reason || ''}`));
  const orig = console.error.bind(console);
  console.error = (...args) => { report('error', args.map(String).join(' ')); orig(...args); };
})();
