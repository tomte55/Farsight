// Runtime-agnostic config logic (no node:*, no Electron): safe to unit-test in
// isolation and to import from either app's main process. The signaling URL is
// the single configurable knob; TURN follows it at runtime.
import { assertSecureSignalingUrl } from './signaling-url.js';

// parallelConnections: the "Parallel connections" send setting (Plan 3 Task 6)
// — how many parallel WebRTC flows a send opens; plumbed to the sender's
// `flowCount` (main.js). Unlike signalingUrl/controlAllowed/receivedFilesDir
// (which are DROPPED when invalid, leaving the reader to apply its own
// default), a bad parallelConnections value is instead CLAMPED/DEFAULTED right
// here — a send always needs a concrete flowCount to proceed, so there's no
// useful "absent" state to preserve once the key is present at all.
export const DEFAULT_PARALLEL_CONNECTIONS = 8;
const MIN_PARALLEL_CONNECTIONS = 1;
const MAX_PARALLEL_CONNECTIONS = 32;

// Effective parallel-connections count for ANY input: a real number or a
// non-blank numeric string coerces and clamps into [1,32]; anything else
// (absent, null, boolean, object, blank/non-numeric string, NaN) falls back to
// the default. This is the single place the clamp/default logic lives —
// parseConfig below and main.js's read-site both call it, mirroring how
// resolveSignalingUrl is the one place signalingUrl's env/config/null
// precedence lives.
export function resolveParallelConnections(value) {
  const n = typeof value === 'number' ? value
    : (typeof value === 'string' && value.trim() !== '') ? Number(value)
      : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL_CONNECTIONS;
  return Math.min(MAX_PARALLEL_CONNECTIONS, Math.max(MIN_PARALLEL_CONNECTIONS, Math.round(n)));
}

// Tolerant parse: bad/missing/corrupt input yields an empty config, never throws.
export function parseConfig(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') {
      const out = {};
      if (typeof obj.signalingUrl === 'string') out.signalingUrl = obj.signalingUrl;
      // controlAllowed: the "Allow this computer to be controlled" toggle
      // (default true when absent — see readControlAllowed in controller
      // main.js). Only a real boolean is honored; anything else is dropped
      // so a corrupt/foreign value can't silently disable the receiver-side
      // gate or be mistaken for an explicit false.
      if (typeof obj.controlAllowed === 'boolean') out.controlAllowed = obj.controlAllowed;
      // receivedFilesDir: the user-chosen folder for INCOMING files (default
      // Downloads/Farsight/Received when unset — see receivedFilesDir() in
      // controller main.js). Only a non-empty string is honored.
      if (typeof obj.receivedFilesDir === 'string' && obj.receivedFilesDir.trim() !== '') {
        out.receivedFilesDir = obj.receivedFilesDir;
      }
      // parallelConnections: only included when the KEY is present at all (an
      // absent key stays absent, same as the other fields above — main.js's
      // read-site applies the default for that case via resolveParallelConnections
      // too), but a PRESENT-and-invalid value resolves to the default instead
      // of being dropped — see resolveParallelConnections's doc comment.
      if (Object.prototype.hasOwnProperty.call(obj, 'parallelConnections')) {
        out.parallelConnections = resolveParallelConnections(obj.parallelConnections);
      }
      return out;
    }
  } catch { /* fall through to empty */ }
  return {};
}

// Pretty JSON for on-disk storage; empty/blank fields are dropped.
export function serializeConfig(cfg) {
  const out = {};
  if (cfg && typeof cfg.signalingUrl === 'string' && cfg.signalingUrl.trim() !== '') {
    out.signalingUrl = cfg.signalingUrl.trim();
  }
  if (cfg && typeof cfg.controlAllowed === 'boolean') {
    out.controlAllowed = cfg.controlAllowed;
  }
  if (cfg && typeof cfg.receivedFilesDir === 'string' && cfg.receivedFilesDir.trim() !== '') {
    out.receivedFilesDir = cfg.receivedFilesDir.trim();
  }
  // parallelConnections: serialize whenever the key is set at all (including a
  // value equal to the default — matches receivedFilesDir's "no special-casing
  // the default value" style), always through resolveParallelConnections so an
  // out-of-range/invalid in-memory value can never be persisted verbatim.
  if (cfg && cfg.parallelConnections !== undefined) {
    out.parallelConnections = resolveParallelConnections(cfg.parallelConnections);
  }
  return JSON.stringify(out, null, 2);
}

// Validate a URL destined for storage. Returns the trimmed/normalized URL or throws.
export function validateSignalingUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('signaling URL is required');
  }
  return assertSecureSignalingUrl(url.trim());
}

// Effective URL: env override beats stored config beats "unset".
export function resolveSignalingUrl({ envUrl, storedUrl } = {}) {
  if (typeof envUrl === 'string' && envUrl.trim() !== '') {
    return { url: envUrl.trim(), source: 'env' };
  }
  if (typeof storedUrl === 'string' && storedUrl.trim() !== '') {
    return { url: storedUrl.trim(), source: 'config' };
  }
  return { url: null, source: null };
}
