// packages/shared/src/credentials-format.js
// Pure, runtime-agnostic (NO node: imports) so the sandboxed renderers can
// import it. Separators are presentational only — the canonical value is raw.

// Strip any char that is not part of the unambiguous password alphabet.
const NON_PW = /[^23456789abcdefghjkmnpqrstuvwxyz]/g;

export function normalizeHostId(input) {
  return String(input ?? '').replace(/\D/g, '');
}

export function formatHostId(id) {
  // Group the normalized digits into threes separated by a single space.
  return normalizeHostId(id).replace(/(\d{3})(?=\d)/g, '$1 ');
}

export function normalizePassword(input) {
  return String(input ?? '').toLowerCase().replace(NON_PW, '');
}

// Ordered, de-duplicated list of password values to try for a typed entry.
// The normalized form (current v1.4+ format) is tried first; the raw typed
// value is a compat fallback for pre-v1.4 hosts that registered the dashed
// literal shown on screen (normalizePassword would strip those separators and
// never match). Empty/whitespace-only input yields no candidates.
export function passwordCandidates(input) {
  const raw = String(input ?? '').trim();
  const out = [];
  const norm = normalizePassword(raw);
  if (norm) out.push(norm);
  if (raw && raw !== norm) out.push(raw);
  return out;
}
