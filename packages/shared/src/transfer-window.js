// packages/shared/src/transfer-window.js
// Pure sizing math for the ft-bulk send window (the credit backpressure keeps at
// most this many bytes in flight per flow, so throughput <= window / RTT). No
// fs/WebRTC/DOM — the transfer worker imports this and applies the result to
// RTCDataChannel.bufferedAmountLowThreshold; tests exercise the math directly.
//
// A fixed window is a compromise: too small starves a high-RTT relay path (256 KB
// caps a flow at ~1.8 MB/s over a 210ms NL<->South-America link), too large wastes
// memory and, because ft-ctrl shares the SCTP association, delays cancel/progress
// frames behind a deep bulk backlog. So size it to the bandwidth-delay product of
// a target rate at the MEASURED RTT, clamped to a safe band.

export const MIN_SEND_WINDOW = 1 * 1024 * 1024;      // never so small a flow starves
export const MAX_SEND_WINDOW = 8 * 1024 * 1024;      // ft-ctrl shares SCTP — cap the backlog
export const DEFAULT_SEND_WINDOW = 4 * 1024 * 1024;  // used until RTT is measured (the pre-adaptive 1.1 value)

// Target single-flow throughput the window is sized for (bytes/sec). Sits in the
// middle of the observed 100-500 Mbps uplink range; combined with the 1.5x
// headroom it drives the window to MAX on the ~210ms relay path and down to MIN on
// a sub-ms LAN. Multi-flow (auto flow scaling) is what scales aggregate throughput
// beyond one window/RTT — this constant is not a per-link bandwidth estimate.
export const DEFAULT_TARGET_RATE = 32 * 1024 * 1024;
export const SEND_WINDOW_HEADROOM = 1.5; // fill slightly past the raw BDP so credit/ACK jitter can't drain the pipe

// windowBytes = clamp(min, targetRate * rttSeconds * headroom, max).
// An unknown/invalid RTT returns `fallback` (DEFAULT_SEND_WINDOW) — the primary
// use case is a high-RTT relay, so a mid-band default is the safe pre-measurement
// choice.
export function computeSendWindow(rttSeconds, opts = {}) {
  const {
    targetRate = DEFAULT_TARGET_RATE,
    min = MIN_SEND_WINDOW,
    max = MAX_SEND_WINDOW,
    headroom = SEND_WINDOW_HEADROOM,
    fallback = DEFAULT_SEND_WINDOW,
  } = opts;
  if (typeof rttSeconds !== 'number' || !(rttSeconds > 0) || !Number.isFinite(rttSeconds)) return fallback;
  const bdp = targetRate * rttSeconds * headroom;
  return Math.max(min, Math.min(max, Math.round(bdp)));
}

// Selected candidate-pair RTT (seconds) from a getStats() entries array — the
// nominated pair, else any succeeded pair. Null when there's no usable pair or it
// carries no currentRoundTripTime yet. Mirrors stats.js's pair selection but
// returns raw seconds (what computeSendWindow wants), not rounded ms.
export function selectedPairRttSeconds(entries) {
  if (!Array.isArray(entries)) return null;
  const pairs = entries.filter((e) => e && e.type === 'candidate-pair');
  const pair = pairs.find((e) => e.nominated === true) || pairs.find((e) => e.state === 'succeeded') || null;
  return pair && typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null;
}
