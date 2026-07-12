// Runtime-agnostic config logic (no node:*, no Electron): safe to unit-test in
// isolation and to import from either app's main process. The signaling URL is
// the single configurable knob; TURN follows it at runtime.
import { assertSecureSignalingUrl } from './signaling-url.js';

// Tolerant parse: bad/missing/corrupt input yields an empty config, never throws.
export function parseConfig(text) {
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && typeof obj.signalingUrl === 'string') {
      return { signalingUrl: obj.signalingUrl };
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
