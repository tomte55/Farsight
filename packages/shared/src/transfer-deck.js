// Pure deck-model helpers for the Transfers page Telemetry Deck. Runtime-agnostic
// (no DOM/Node) — the renderer paints what these return. Mirrors transfer-detail.js.
import { bytesDone, filesDone, formatBytes, formatRate, formatDuration, etaSeconds } from './transfer-rate.js';
import { flowHealthLabel } from './transfer-detail.js';

// Friendly state pill text for the states the deck can show (the deck only ever
// renders the ACTIVE head send, so terminal states aren't mapped here).
const STATE_PILL = {
  active: 'Transferring',
  reconnecting: 'Reconnecting',
  finishing: 'Verifying',
  verifying: 'Verifying',
  'awaiting-approval': 'Waiting for approval',
};

// One descriptor per parallel flow for the flow-lane equalizer. The multi-flow
// aggregate only exposes counts (flowsTotal/flowsLive), not per-flow state, so a
// lane is 'healthy' (connected) or 'dead' (a slot currently down). Amber
// "re-dialing" per-lane is deferred until per-flow rate exists (a later plan);
// the cumulative re-dial COUNT still shows as text via deckModel().flowText.
export function flowLaneSpec(progress) {
  const total = Number.isFinite(progress?.flowsTotal) ? progress.flowsTotal : 0;
  if (total <= 1) return [];
  const liveRaw = Number.isFinite(progress?.flowsLive) ? progress.flowsLive : total;
  const live = Math.max(0, Math.min(total, liveRaw));
  const lanes = [];
  for (let i = 0; i < total; i += 1) lanes.push({ state: i < live ? 'healthy' : 'dead' });
  return lanes;
}

export function deckModel(job, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const peakRate = Number.isFinite(opts.peakRate) ? opts.peakRate : 0;
  const p = (job && job.progress) || {};
  const total = Number.isFinite(p.total) && p.total > 0 ? p.total : 0;
  const done = total ? bytesDone(p) : 0;
  const rate = Number.isFinite(job && job.rate) && job.rate > 0 ? job.rate : 0;
  const eta = rate && total ? etaSeconds(total - done, rate) : null;
  const createdAt = job && Number.isFinite(job.createdAt) ? job.createdAt : 0;
  const elapsedSec = createdAt && now > createdAt ? Math.floor((now - createdAt) / 1000) : 0;
  const filesTotal = Number.isFinite(p.filesTotal) ? p.filesTotal
    : (job && job.manifest && (job.manifest.totalFiles ?? (job.manifest.entries || []).length)) || 0;
  return {
    arrow: job && job.direction === 'recv' ? '↓' : '↑',
    statePill: STATE_PILL[job && job.state] || 'Transferring',
    rateText: rate ? formatRate(rate) : '',
    peakText: peakRate ? formatRate(peakRate) : '',
    fraction: total ? Math.min(1, Math.max(0, done / total)) : (job && job.state === 'done' ? 1 : 0),
    transferredText: total ? `${formatBytes(done)} / ${formatBytes(total)}` : '',
    filesText: filesTotal ? `${filesDone(p)} / ${filesTotal}` : '',
    etaText: eta !== null && job && job.state === 'active' ? `~${formatDuration(eta)}` : '',
    elapsedText: elapsedSec ? formatDuration(elapsedSec) : '',
    flowText: flowHealthLabel(p) || '',
    lanes: flowLaneSpec(p),
  };
}
