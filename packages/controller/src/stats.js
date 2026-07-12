// packages/controller/src/stats.js
// Pure summarizer for RTCPeerConnection.getStats() output — no timing/interval
// logic here (that lives in the renderer poller). Kept side-effect free and
// runtime-agnostic so it's unit-testable without a real RTCPeerConnection.

// Extract the fields we care about from a raw RTCStatsReport (Map-like of
// stats objects, keyed by id). Does not do any cross-sample math.
export function extractStats(report) {
  const entries = [...report.values()];

  const pairs = entries.filter((e) => e.type === 'candidate-pair');
  const pair = pairs.find((e) => e.nominated === true) || pairs.find((e) => e.state === 'succeeded') || null;

  const rttMs = pair && typeof pair.currentRoundTripTime === 'number'
    ? Math.round(pair.currentRoundTripTime * 1000)
    : null;

  let transport = null;
  if (pair && pair.localCandidateId) {
    const localCandidate = entries.find((e) => e.id === pair.localCandidateId && e.type === 'local-candidate');
    if (localCandidate) transport = localCandidate.candidateType === 'relay' ? 'relay' : 'direct';
  }

  const videoInbound = entries.find((e) => e.type === 'inbound-rtp' && e.kind === 'video') || null;
  const bytes = videoInbound && typeof videoInbound.bytesReceived === 'number' ? videoInbound.bytesReceived : null;
  const ts = videoInbound && typeof videoInbound.timestamp === 'number' ? videoInbound.timestamp : null;
  const width = videoInbound && typeof videoInbound.frameWidth === 'number' ? videoInbound.frameWidth : null;
  const height = videoInbound && typeof videoInbound.frameHeight === 'number' ? videoInbound.frameHeight : null;

  return { rttMs, bytes, ts, width, height, transport };
}

// Throughput (kbps) between two extractStats() samples, from bytes/ts deltas.
// Null if either sample lacks bytes/ts, or the time delta isn't positive.
export function throughputKbps(prev, cur) {
  if (!prev || !cur) return null;
  if (typeof prev.bytes !== 'number' || typeof prev.ts !== 'number') return null;
  if (typeof cur.bytes !== 'number' || typeof cur.ts !== 'number') return null;
  const deltaTs = cur.ts - prev.ts;
  if (deltaTs <= 0) return null;
  const deltaBytes = cur.bytes - prev.bytes;
  return (deltaBytes * 8) / deltaTs;
}

// Build a "· "-joined display string from a summary: { rttMs, kbps, width,
// height, transport }. Omits parts that are missing; "—" if nothing present.
export function formatQuality(summary) {
  const parts = [];
  const { rttMs, kbps, width, height, transport } = summary || {};

  if (typeof rttMs === 'number') parts.push(`${rttMs} ms`);
  if (typeof kbps === 'number') {
    parts.push(kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);
  }
  if (typeof width === 'number' && typeof height === 'number') parts.push(`${width}×${height}`);
  if (transport) parts.push(transport);

  return parts.length ? parts.join(' · ') : '—';
}
