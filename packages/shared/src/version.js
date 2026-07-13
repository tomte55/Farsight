// packages/shared/src/version.js
// Pure, runtime-agnostic (NO node: imports) semver-lite helpers so the sandboxed
// renderers can compare app versions for graceful cross-version handling (SP1).
// We only care about major.minor.patch — pre-release/build metadata is ignored.

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = RE.exec(input.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// -1 if a < b, 0 if equal, 1 if a > b. Returns null when either side is
// unparseable — an unknown comparison must never be reported as a difference.
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

export function isOlder(a, b) { return compareVersions(a, b) === -1; }
export function isNewer(a, b) { return compareVersions(a, b) === 1; }
