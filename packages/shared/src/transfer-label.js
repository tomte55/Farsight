// packages/shared/src/transfer-label.js
// A human label for a transfer, by what is being sent/received — the file or
// folder name — rather than the peer id (which is often unknown: it isn't
// persisted for receives, and a job reloaded from disk after a restart has lost
// the live target). Pure + runtime-agnostic so it unit-tests and runs in the
// sandboxed renderer.
//
// Preference order:
//   1. sourceRoots (send-only, absolute local paths the user picked) — the most
//      accurate: basename of the first, "+N" when several were picked.
//   2. manifest.entries — works for a received transfer too. A folder send shares
//      one top path segment across entries with subpaths → that folder's name; a
//      single flat file → its name; several flat files → "first +N".
//   3. a known peer id, else a generic fallback.

function baseName(p) {
  const parts = String(p == null ? '' : p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

export function transferLabel(job = {}) {
  const roots = Array.isArray(job.sourceRoots) ? job.sourceRoots.filter(Boolean) : [];
  if (roots.length) {
    const first = baseName(roots[0]);
    return roots.length > 1 ? `${first} +${roots.length - 1}` : first;
  }

  const entries = job.manifest && Array.isArray(job.manifest.entries) ? job.manifest.entries : [];
  if (entries.length) {
    const segs = entries.map((e) => String((e && e.path) || '').split('/').filter(Boolean));
    const tops = new Set(segs.map((s) => s[0]).filter(Boolean));
    const hasSubdir = segs.some((s) => s.length > 1);
    if (tops.size === 1 && hasSubdir) return [...tops][0];      // a folder → its name
    if (entries.length === 1) return baseName(entries[0].path);  // one flat file
    return `${baseName(entries[0].path)} +${entries.length - 1}`; // several flat files
  }

  const peerId = (job.target && job.target.id) || (job.peer && job.peer.id);
  return peerId || 'files';
}
