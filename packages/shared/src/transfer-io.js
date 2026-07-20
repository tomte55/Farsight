// packages/shared/src/transfer-io.js
// SP3 (spec §6) MAIN-ONLY streamed-to-disk transfer io. Uses node:fs/crypto/path
// like updater.js/device-keypair.js — NEVER imported by a sandboxed renderer.
// Consumes the pure transfer-manifest.js for path safety.
import { stat, readdir, open, mkdir, rename, utimes, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve, join, sep, basename, dirname } from 'node:path';
import { sanitizeRelativePath } from './transfer-manifest.js';

// SECURITY-CRITICAL (spec §6.3): a received relative path must be safe (Phase-1
// guard) AND resolve to a location strictly under destRoot. Throws otherwise.
export function confineDestPath(destRoot, relPath) {
  const safe = sanitizeRelativePath(relPath);
  if (safe === null) throw new Error('unsafe path');
  const rootAbs = resolve(destRoot);
  // Separator-bounded prefix so a sibling like C:\dest-evil can't pass as C:\dest.
  // Guard against a destRoot that is itself a filesystem/drive root (already ends in sep).
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  const full = resolve(rootAbs, safe);
  if (full !== rootAbs && !full.startsWith(rootPrefix)) throw new Error('unsafe path');
  return full;
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

// Finalize a received file by PATH (no open handle) — for the multi-flow receiver,
// where a resumed/already-complete file may have no open partFile. Reads the .part
// fresh (no held fd → safe rename on Windows), verifies, publishes. Idempotent across
// resume: a file already finalized in a prior run (no .part, final present) returns ok
// without re-hashing; nothing on disk returns not-ok.
export async function finalizeReceivedPath({ destRoot, relPath, expectedHash, mtime }) {
  const finalPath = confineDestPath(destRoot, relPath);
  const partPath = `${finalPath}.part`;
  let partExists = true;
  try { await stat(partPath); } catch (e) { if (e && e.code === 'ENOENT') partExists = false; else throw e; }
  if (!partExists) {
    try { await stat(finalPath); return { ok: true }; } catch (e) { if (e && e.code === 'ENOENT') return { ok: false }; throw e; }
  }
  const actual = await hashFile(partPath);
  if (actual !== expectedHash) { await rm(partPath, { force: true }); return { ok: false }; }
  await rename(partPath, finalPath);
  const secs = mtime / 1000;
  await utimes(finalPath, secs, secs);
  return { ok: true };
}

// Positional (sparse) .part writer for the multi-flow receiver: chunks arrive out
// of order on many flows and are written at their byte offset, so the .part is
// sparse and its size is NOT the resume offset (received-ranges are; see the
// orchestrator). liveDigest() is always null — an out-of-order file can only be
// verified by a completion read at finalize (see finalizeReceivedPath).
export async function createSparsePartFile({ destRoot, relPath, size }) {
  const finalPath = confineDestPath(destRoot, relPath);
  const partPath = `${finalPath}.part`;
  await mkdir(dirname(finalPath), { recursive: true });
  // Open for positional read+write: create-if-absent without truncating an
  // existing .part (resume keeps prior bytes), and allow writing at arbitrary offsets.
  let exists = false;
  try { await stat(partPath); exists = true; } catch { /* doesn't exist */ }
  const fh = await open(partPath, exists ? 'r+' : 'w+');
  // Preallocate to the final size (best-effort): reserving the length up front
  // lets the FS lay the file out contiguously instead of extending it on every
  // out-of-order writeAt (fragmentation), and makes the finalize completion-read
  // sequential. GROW ONLY — never truncate below the current on-disk size, which
  // would destroy already-received bytes on a resume with a stale/smaller size
  // hint. Skipped when size is unknown (back-compat with callers that omit it).
  if (Number.isInteger(size) && size > 0) {
    try { if ((await fh.stat()).size < size) await fh.truncate(size); } catch { /* optimization only */ }
  }
  return {
    partPath,
    finalPath,
    async writeAt(offset, buf) { await fh.write(buf, 0, buf.length, offset); },
    // Phase 4: read a chunk back for verification (ctrl/bulk-race retro-verify) and
    // for the finalize-mismatch locate pass. Clamps at EOF like openSourceReader.
    async readAt(offset, length) {
      const b = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(b, 0, length, offset);
      return new Uint8Array(b.subarray(0, bytesRead));
    },
    liveDigest() { return null; },
    async fsync() { await fh.sync(); },
    async close() { await fh.close(); },
  };
}

// Positional source reader for the sender's producer: reads exactly the bytes
// present (clamped at EOF), at an arbitrary offset, without a streaming cursor.
export async function openSourceReader(sourcePath) {
  const fh = await open(sourcePath, 'r');
  return {
    async readAt(offset, length) {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return new Uint8Array(buf.subarray(0, bytesRead));
    },
    async close() { await fh.close(); },
  };
}
