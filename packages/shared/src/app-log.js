// packages/shared/src/app-log.js
// Composes the pure logger (log.js) with the rotating file sink (log-file-sink.js)
// into the app-wide root logger. All primitives injected for testability.
import { createLogger } from './log.js';
import { createFileSink } from './log-file-sink.js';

const ORDER = ['debug', 'info', 'warn', 'error'];

export function resolveMinLevel({ env = {}, isPackaged = true } = {}) {
  const fromEnv = String(env.FARSIGHT_LOG_LEVEL || '').toLowerCase();
  if (ORDER.includes(fromEnv)) return fromEnv;
  return isPackaged ? 'info' : 'debug';
}

export function createAppLogger({ filePath, fs, dirname, isPackaged = true, env = {}, mirror = null }) {
  const minLevel = resolveMinLevel({ env, isPackaged });
  const fileSink = createFileSink({ filePath, fs, dirname });
  const sink = mirror ? (line) => { fileSink(line); mirror(line); } : fileSink;
  return { log: createLogger({ sink, minLevel }), minLevel, filePath };
}
