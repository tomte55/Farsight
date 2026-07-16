import { expect, test } from 'vitest';
import { buildDiagnosticsBundle } from '../src/diagnostics-bundle.js';
function fakeFs(map, sizes) {
  return {
    existsSync: () => true,
    readdirSync: () => Object.keys(map),
    readFileSync: (p) => map[p.split(/[\\/]/).pop()],
    statSync: (p) => ({ size: sizes[p.split(/[\\/]/).pop()], mtimeMs: sizes[p.split(/[\\/]/).pop()] }),
  };
}
test('includes log files and respects the byte cap (newest first)', () => {
  const map = { 'main.log': 'newest', 'main.log.1': 'older' };
  const sizes = { 'main.log': 2, 'main.log.1': 1 };
  const { files, meta } = buildDiagnosticsBundle({ logsDir: '/logs', fs: fakeFs(map, sizes), meta: { app: 'host' }, maxBytes: 4 });
  expect(files['main.log']).toBe('newest');
  expect(meta.app).toBe('host');
});
test('never includes non-log files', () => {
  const map = { 'main.log': 'a', 'config.json': 'secret' };
  const { files } = buildDiagnosticsBundle({ logsDir: '/logs', fs: fakeFs(map, { 'main.log': 1, 'config.json': 1 }), meta: {}, maxBytes: 100 });
  expect(files['config.json']).toBeUndefined();
});
