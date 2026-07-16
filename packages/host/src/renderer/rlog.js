// packages/host/src/renderer/rlog.js
// Renderer-side logger that forwards breadcrumbs to the main-process file log
// over IPC (the sandboxed renderer has no fs). Same shape as the shared logger
// ({debug,info,warn,error,child}) so connection modules accept either. Callers
// MUST pass only non-sensitive text — never SDP/ICE, password, clipboard,
// keystrokes, or file contents (mirrors packages/shared/src/log.js).
const MAX_MSG = 2000;
export function createRendererLogger(scope = '', send = (e) => window.farsightIpc?.log?.(e)) {
  const emit = (level, msg) => {
    try { send({ level, scope, msg: String(msg).slice(0, MAX_MSG) }); } catch { /* logging never throws */ }
  };
  return {
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    child: (s) => createRendererLogger(scope ? `${scope}:${s}` : s, send),
  };
}
