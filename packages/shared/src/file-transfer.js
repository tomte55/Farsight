// packages/shared/src/file-transfer.js
// Pure, environment-agnostic protocol logic for bidirectional file transfer
// over the dedicated 'file' WebRTC data channel (see packages/*/src/peer.js).
// NO fs, NO DOM, NO WebRTC here — byte concatenation and disk I/O stay in the
// renderer/main process. This module only frames messages and tracks receive
// progress as a pure state machine, so it can be unit-tested in isolation.

export const CHUNK_SIZE = 16384;
export const MAX_FILE_SIZE = 104857600; // 100 MB

function isNonNegInt(n) {
  return Number.isInteger(n) && n >= 0;
}

// name: string, size: non-negative integer <= MAX_FILE_SIZE, mime: string.
export function validateMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (typeof meta.name !== 'string') return false;
  if (!isNonNegInt(meta.size) || meta.size > MAX_FILE_SIZE) return false;
  if (typeof meta.mime !== 'string') return false;
  return true;
}

export function metaFrame({ id, name, size, mime }) {
  return JSON.stringify({ t: 'meta', id, name, size, mime });
}

export function endFrame(id) {
  return JSON.stringify({ t: 'end', id });
}

export function cancelFrame(id) {
  return JSON.stringify({ t: 'cancel', id });
}

// Tolerant parser: returns null (never throws) on bad JSON or an unrecognized
// shape, so a malformed/hostile peer message is simply dropped by the caller.
export function parseFrame(str) {
  if (typeof str !== 'string') return null;
  let obj;
  try { obj = JSON.parse(str); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.t === 'meta') {
    if (!Number.isInteger(obj.id)) return null;
    if (!validateMeta(obj)) return null;
    return { t: 'meta', id: obj.id, name: obj.name, size: obj.size, mime: obj.mime };
  }
  if (obj.t === 'end' || obj.t === 'cancel') {
    if (!Number.isInteger(obj.id)) return null;
    return { t: obj.t, id: obj.id };
  }
  return null;
}

// SECURITY-CRITICAL: keep only the basename and strip any ".." sequence, so a
// received filename can never be used to write outside the chosen save
// directory (path traversal). Always falls back to a safe default.
export function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'download';
  const normalized = name.replace(/\\/g, '/');
  const parts = normalized.split('/');
  let base = parts[parts.length - 1] || '';
  base = base.replace(/\.\./g, '').trim();
  return base === '' ? 'download' : base;
}

// Pure receive-side state machine. No I/O: the caller (renderer) owns the
// actual ArrayBuffer chunks and byte concatenation; this only tracks
// name/size/mime/progress/completion.
export function createReceiver({ onProgress = () => {} } = {}) {
  let name = null;
  let mime = null;
  let size = 0;
  let received = 0;
  let complete = false;

  return {
    begin(meta) {
      if (!validateMeta(meta)) throw new Error('invalid file meta');
      name = sanitizeFilename(meta.name);
      mime = meta.mime;
      size = meta.size;
      received = 0;
      complete = received >= size; // handles zero-byte files
    },
    pushChunkBytes(n) {
      if (!Number.isInteger(n) || n < 0) return;
      received += n;
      if (size > 0) onProgress(received / size);
      else onProgress(1);
      if (received >= size) complete = true;
    },
    end() {
      complete = true;
    },
    get received() { return received; },
    get size() { return size; },
    isComplete() { return complete; },
    get name() { return name; },
    get mime() { return mime; },
  };
}
