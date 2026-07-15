// packages/shared/src/transfer-io.js
// SP3 (spec §6) MAIN-ONLY streamed-to-disk transfer io. Uses node:fs/crypto/path
// like updater.js/device-keypair.js — NEVER imported by a sandboxed renderer.
// Consumes the pure transfer-manifest.js for path safety.
import { statfs, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve, join, sep, basename } from 'node:path';
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

// Walk each root (a file or a directory) into manifest entries. Directory roots
// contribute paths rooted at the directory's own name (so "send this folder"
// preserves the folder). Posix separators for the wire. Symlinks skipped.
export async function walkSource(roots) {
  const entries = [];
  const sources = new Map();
  let nextId = 0;
  async function addFile(absPath, relPosix) {
    const st = await stat(absPath);
    const fileId = nextId++;
    entries.push({ fileId, path: relPosix, size: st.size, mtime: Math.floor(st.mtimeMs) });
    sources.set(fileId, absPath);
  }
  async function walkDir(absDir, relPrefix) {
    const names = (await readdir(absDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const d of names) {
      if (d.isSymbolicLink()) continue; // not followed in this plan
      const abs = join(absDir, d.name);
      const rel = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      if (d.isDirectory()) await walkDir(abs, rel);
      else if (d.isFile()) await addFile(abs, rel);
    }
  }
  for (const r of roots) {
    const st = await stat(r.path);
    const name = basename(r.path);
    if (st.isDirectory()) await walkDir(r.path, name);
    else if (st.isFile()) await addFile(r.path, name);
  }
  return { entries, sources };
}
