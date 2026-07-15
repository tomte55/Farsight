// Pure manifest logic for SP3 file transfer: path-safety, entry validation,
// manifest assembly, and skip-existing. NO fs/crypto/DOM (spec §4).

function isNonNegInt(n) {
  return Number.isInteger(n) && n >= 0;
}

// SECURITY-CRITICAL (spec §6/§10): return a safe posix relative path, or null
// if the input is absolute, escapes via "..", or carries a drive-letter/":"
// segment. Rejects (returns null) rather than silently rewriting structure.
export function sanitizeRelativePath(p) {
  if (typeof p !== 'string') return null;
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('/')) return null; // absolute
  const out = [];
  for (const seg of norm.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    if (seg.includes(':')) return null; // drive letter / NTFS stream
    out.push(seg);
  }
  return out.length === 0 ? null : out.join('/');
}

export function validateEntry(e) {
  if (!e || typeof e !== 'object') return false;
  if (!isNonNegInt(e.fileId)) return false;
  if (typeof e.path !== 'string' || sanitizeRelativePath(e.path) === null) return false;
  if (!isNonNegInt(e.size)) return false;
  if (typeof e.mtime !== 'number' || !Number.isFinite(e.mtime)) return false;
  return true;
}
