// packages/shared/src/transfer-rate.js
// SP3 receiver-UX (spec §5.6): rolling-window transfer rate, ETA, and the
// byte/rate/duration formatting both apps' transfer panels render. Pure — the
// clock is injected, so this is fully unit-testable and runs unchanged in the
// sandboxed renderer (no node: imports).

// Rate from a rolling window of CUMULATIVE byte samples. A window (rather than
// an all-run average) keeps the number responsive: after a stall or a resume the
// displayed speed recovers in `windowMs` instead of being dragged by history.
export function createRateEstimator({ windowMs = 5000, now = () => Date.now() } = {}) {
  let samples = []; // [{ t, bytes }] oldest → newest, cumulative bytes

  function rate() {
    if (samples.length < 2) return null;
    const first = samples[0], last = samples[samples.length - 1];
    const dt = last.t - first.t;
    if (!(dt > 0)) return null; // same-instant samples: no rate, and never divide by 0
    return ((last.bytes - first.bytes) * 1000) / dt;
  }

  return {
    sample(totalBytes) {
      const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
      const t = now();
      const last = samples[samples.length - 1];
      // Cumulative count went backwards → this is a different run of the same job
      // (a resume re-walks and re-counts). The old window would produce a wild
      // negative/huge rate, so drop it and start over from here.
      if (last && bytes < last.bytes) samples = [];
      samples.push({ t, bytes });
      // Keep everything inside the window, plus one anchor sample just outside it
      // so a slow feed still has two points to measure between.
      const cutoff = t - windowMs;
      let keepFrom = 0;
      for (let i = 0; i < samples.length; i += 1) if (samples[i].t < cutoff) keepFrom = i;
      if (keepFrom > 0) samples = samples.slice(keepFrom);
      return rate();
    },
    rate,
    reset() { samples = []; },
  };
}

// Seconds until `remainingBytes` are done at `bytesPerSec`. Null when there is no
// usable rate yet or the transfer is stalled — the caller shows nothing rather
// than "Infinity" or a fabricated estimate.
export function etaSeconds(remainingBytes, bytesPerSec) {
  if (!Number.isFinite(remainingBytes) || remainingBytes < 0) return null;
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return null;
  return remainingBytes / bytesPerSec;
}

// The receiver's progress calls it `received`, the sender's calls it `sent`
// (transfer-engine.js:12-19 vs :64-72). One normalizer so the panels don't each
// hand-roll the fallback.
export function bytesDone(progress) {
  if (!progress) return 0;
  if (Number.isFinite(progress.received)) return progress.received;
  if (Number.isFinite(progress.sent)) return progress.sent;
  return 0;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

// Binary units with the labels users expect from Windows (1 GB = 1024^3).
export function formatBytes(n) {
  let v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1024) return `${Math.round(v)} B`;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(1)} ${UNITS[u]}`;
}

export function formatRate(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

// Coarse on purpose: an ETA precise to the second is noise on a multi-hour transfer.
export function formatDuration(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
