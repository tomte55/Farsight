// Pure rolling rate-sample buffer + SVG path builder for the deck throughput
// waveform. Runtime-agnostic (no DOM/Node). now/rate injected by the caller.

export function pushSample(samples, t, rate, opts = {}) {
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : 60000;
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : 240;
  const r = Math.max(0, Number.isFinite(rate) ? rate : 0);
  const next = (samples || []).filter((s) => t - s.t <= maxAgeMs);
  next.push({ t, rate: r });
  if (next.length > maxLen) next.splice(0, next.length - maxLen);
  return next;
}

export function waveformPath(samples, w, h, opts = {}) {
  if (!samples || samples.length === 0) return { line: '', area: '', max: 0 };
  const pad = Number.isFinite(opts.pad) ? opts.pad : 2;
  const seed = Number.isFinite(opts.max) ? opts.max : 0;
  const peak = Math.max(seed, ...samples.map((s) => s.rate), 1);
  const t0 = samples[0].t;
  const tSpan = Math.max(1, samples[samples.length - 1].t - t0);
  const x = (t) => ((t - t0) / tSpan) * w;
  const y = (r) => h - pad - (r / peak) * (h - pad * 2);
  const pts = samples.map((s) => `${x(s.t).toFixed(1)},${y(s.rate).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${w.toFixed(1)},${h.toFixed(1)} L0.0,${h.toFixed(1)} Z`;
  return { line, area, max: peak };
}
