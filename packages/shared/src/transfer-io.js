// packages/shared/src/transfer-io.js
// SP3 (spec §6) MAIN-ONLY streamed-to-disk transfer io. Uses node:fs/crypto/path
// like updater.js/device-keypair.js — NEVER imported by a sandboxed renderer.
// Consumes the pure transfer-manifest.js for path safety.
import { statfs, stat, readdir, open, mkdir, rename, utimes, rm } from 'node:fs/promises';
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

// A resumable .part writer. The .part on-disk size IS the durable resume offset
// (spec §6). Live hash is folded in only when hashLive (a continuous run); after
// an app restart the caller passes hashLive:false and verifies by completion read.
export async function createPartFile({ destRoot, relPath, resumeFrom, hashLive }) {
  const finalPath = confineDestPath(destRoot, relPath);
  const partPath = `${finalPath}.part`;
  await mkdir(dirname(finalPath), { recursive: true });
  // resumeFrom 0 → truncate (fresh or restart-at-0); else append at current size.
  const fh = await open(partPath, resumeFrom === 0 ? 'w' : 'a');
  let offset = 0;
  if (resumeFrom !== 0) {
    try { offset = (await fh.stat()).size; } catch { offset = 0; }
  }
  // A live hash is only valid if it covered the file from byte 0 within one
  // continuous run. Resuming (resumeFrom > 0) re-opens the writer and can't
  // reconstruct the prior bytes' hash state, so it MUST fall back to a
  // completion read — force liveDigest() to null in that case (spec §6.4).
  const hash = (hashLive && resumeFrom === 0) ? createHash('sha256') : null;
  let digest = null; // memoized: Node's Hash.digest() throws if called twice
  return {
    offset,
    partPath,
    finalPath,
    async write(buf) {
      await fh.write(buf);
      if (hash) hash.update(buf);
    },
    async fsync() { await fh.sync(); },
    async close() { await fh.close(); },
    liveDigest() {
      if (!hash) return null;
      if (digest === null) digest = hash.digest('hex');
      return digest;
    },
  };
}

// Verify the received file's whole-file hash, then atomically publish it.
// Live digest when available (continuous run); otherwise a single completion
// read (spec §6.4). Mismatch discards the .part so the file re-requests from 0.
export async function finalizeReceivedFile({ partFile, expectedHash, mtime }) {
  const actual = partFile.liveDigest() ?? (await hashFile(partFile.partPath));
  if (actual !== expectedHash) {
    await rm(partFile.partPath, { force: true });
    return { ok: false };
  }
  await rename(partFile.partPath, partFile.finalPath);
  const secs = mtime / 1000;
  await utimes(partFile.finalPath, secs, secs);
  return { ok: true };
}

// Stream a file to the peer while computing its whole-file SHA-256. On resume
// (offset > 0) the bytes before offset are hashed but NOT resent — the receiver
// already has them (spec §6.1/§6.4). onChunk is awaited for backpressure.
export function sendFile({ sourcePath, offset, chunkSize, onChunk }) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    const rs = createReadStream(sourcePath, { highWaterMark: chunkSize });
    // Destroy the stream on any failure so a paused read never leaks its fd
    // (onChunk rejecting mid-transfer leaves the stream paused otherwise).
    const fail = (err) => { try { rs.destroy(); } catch { /* already gone */ } rej(err); };
    let pos = 0;
    let chain = Promise.resolve();
    rs.on('data', (chunk) => {
      h.update(chunk);
      const start = pos;
      const end = pos + chunk.length;
      pos = end;
      if (end > offset) {
        const from = start >= offset ? 0 : offset - start;
        const slice = chunk.subarray(from);
        rs.pause();
        chain = chain
          .then(() => onChunk(slice))
          .then(() => rs.resume())
          .catch(fail);
      }
    });
    rs.on('error', fail);
    rs.on('end', () => { chain.then(() => res({ hash: h.digest('hex') })).catch(fail); });
  });
}
