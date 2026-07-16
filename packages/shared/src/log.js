// packages/shared/src/log.js
// Pure, runtime-agnostic leveled logger. No node:* imports — the app injects the
// sink (a function taking one formatted line). Callers MUST pass only
// non-sensitive text: never the session password, SDP/ICE, clipboard text, or
// file contents (mirrors packages/signaling-server/src/log.js).
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_MSG = 2000; // backstop so a stray large value can't dump a payload

export function createLogger({
  sink = (line) => console.log(line),
  now = () => new Date().toISOString(),
  minLevel = 'info',
  scope = '',
} = {}) {
  const threshold = LEVELS[minLevel] ?? LEVELS.info;
  const write = (level, msg) => {
    if (LEVELS[level] < threshold) return;
    const text = String(msg).slice(0, MAX_MSG).replace(/[\r\n]+/g, ' ');
    const tag = scope ? ` [${scope}]` : '';
    sink(`${now()} ${level.toUpperCase().padEnd(5)}${tag} ${text}`);
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    child: (childScope) =>
      createLogger({ sink, now, minLevel, scope: scope ? `${scope}:${childScope}` : childScope }),
  };
}
