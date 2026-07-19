// Pure deck-model helpers for the Transfers page Telemetry Deck. Runtime-agnostic
// (no DOM/Node) — the renderer paints what these return. Mirrors transfer-detail.js.

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
