// packages/shared/test/app-log.test.js
import { expect, test, vi } from 'vitest';
import { resolveMinLevel, createAppLogger } from '../src/app-log.js';

function fakeFs() {
  const files = new Map();
  return {
    files,
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
    statSync: (p) => ({ size: Buffer.byteLength(files.get(p) ?? '') }),
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? '') + d),
    renameSync: () => {}, rmSync: () => {},
  };
}
const dirname = (p) => p.slice(0, p.lastIndexOf('/'));

test('resolveMinLevel: env wins when valid', () => {
  expect(resolveMinLevel({ env: { FARSIGHT_LOG_LEVEL: 'warn' }, isPackaged: true })).toBe('warn');
});
test('resolveMinLevel: invalid env falls back to packaged/dev default', () => {
  expect(resolveMinLevel({ env: { FARSIGHT_LOG_LEVEL: 'nope' }, isPackaged: true })).toBe('info');
  expect(resolveMinLevel({ env: {}, isPackaged: false })).toBe('debug');
});

test('createAppLogger writes to the file and mirrors when provided', () => {
  const fs = fakeFs();
  const mirror = vi.fn();
  const { log, minLevel } = createAppLogger({
    filePath: '/logs/main.log', fs, dirname, isPackaged: true, env: {}, mirror,
  });
  expect(minLevel).toBe('info');
  log.info('hi');
  expect(fs.files.get('/logs/main.log')).toContain(' INFO  hi\n');
  expect(mirror).toHaveBeenCalledOnce();
});
