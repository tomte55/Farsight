// packages/shared/src/transfer-io.js
// SP3 (spec §6) MAIN-ONLY streamed-to-disk transfer io. Uses node:fs/crypto/path
// like updater.js/device-keypair.js — NEVER imported by a sandboxed renderer.
// Consumes the pure transfer-manifest.js for path safety.
import { statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { sanitizeRelativePath } from './transfer-manifest.js';

// SECURITY-CRITICAL (spec §6.3): a received relative path must be safe (Phase-1
// guard) AND resolve to a location strictly under destRoot. Throws otherwise.
export function confineDestPath(destRoot, relPath) {
  const safe = sanitizeRelativePath(relPath);
  if (safe === null) throw new Error('unsafe path');
  const rootAbs = resolve(destRoot);
  const full = resolve(rootAbs, safe);
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) throw new Error('unsafe path');
  return full;
}

export async function freeSpaceBytes(destRoot) {
  const s = await statfs(destRoot);
  return Number(s.bsize) * Number(s.bavail);
}

export async function hasFreeSpace(destRoot, needBytes) {
  return (await freeSpaceBytes(destRoot)) >= needBytes;
}

// Whole-file SHA-256 (hex). Used for the sender's FILE_END hash and for the
// receiver's completion-read verification after an app restart (spec §6.4).
export function hashFile(absPath) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    const rs = createReadStream(absPath);
    rs.on('data', (c) => h.update(c));
    rs.on('error', rej);
    rs.on('end', () => res(h.digest('hex')));
  });
}
