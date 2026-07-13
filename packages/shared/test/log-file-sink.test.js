// packages/shared/test/log-file-sink.test.js
import { expect, test } from 'vitest';
import { createFileSink } from '../src/log-file-sink.js';

// Minimal in-memory fs shaped like the node:fs functions the sink uses.
function fakeFs() {
  const files = new Map();        // path -> string
  const dirs = new Set();
  return {
    files, dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    statSync: (p) => ({ size: Buffer.byteLength(files.get(p) ?? '') }),
    appendFileSync: (p, data) => { files.set(p, (files.get(p) ?? '') + data); },
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    rmSync: (p) => { files.delete(p); },
  };
}
const dirname = (p) => p.slice(0, p.lastIndexOf('/'));

test('creates the parent dir and appends lines', () => {
  const fs = fakeFs();
  const sink = createFileSink({ filePath: '/logs/main.log', fs, dirname });
  sink('a'); sink('b');
  expect(fs.dirs.has('/logs')).toBe(true);
  expect(fs.files.get('/logs/main.log')).toBe('a\nb\n');
});

test('rotates when the file reaches maxBytes', () => {
  const fs = fakeFs();
  const sink = createFileSink({ filePath: '/logs/main.log', fs, dirname, maxBytes: 5, maxFiles: 2 });
  sink('12345');                 // 6 bytes written -> file now >= 5
  sink('next');                  // next write sees size>=5, rotates first
  expect(fs.files.get('/logs/main.log.1')).toBe('12345\n');
  expect(fs.files.get('/logs/main.log')).toBe('next\n');
});

test('rotation overwrites an existing .1 (Windows-safe) instead of throwing', () => {
  const fs = fakeFs();
  fs.appendFileSync('/logs/main.log.1', 'old\n');   // stale rotated file present
  const sink = createFileSink({ filePath: '/logs/main.log', fs, dirname, maxBytes: 5, maxFiles: 2 });
  sink('12345');
  sink('x');
  expect(fs.files.get('/logs/main.log.1')).toBe('12345\n');   // replaced, not errored
});

test('never throws when fs fails', () => {
  const badFs = { existsSync: () => false, mkdirSync: () => { throw new Error('EACCES'); } };
  const sink = createFileSink({ filePath: '/logs/main.log', fs: badFs, dirname });
  expect(() => sink('a')).not.toThrow();
});
