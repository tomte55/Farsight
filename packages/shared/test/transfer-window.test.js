// packages/shared/test/transfer-window.test.js
import { expect, test, describe } from 'vitest';
import {
  computeSendWindow,
  selectedPairRttSeconds,
  MIN_SEND_WINDOW,
  MAX_SEND_WINDOW,
  DEFAULT_SEND_WINDOW,
} from '../src/transfer-window.js';

describe('computeSendWindow: BDP-sized ft-bulk send window from measured RTT', () => {
  test('applies the targetRate * rtt * 1.5 headroom formula (unclamped range)', () => {
    // Explicit bounds wide open so we test the raw formula, not the clamp.
    const w = computeSendWindow(0.1, { targetRate: 10 * 1024 * 1024, min: 0, max: Infinity });
    expect(w).toBe(Math.round(10 * 1024 * 1024 * 0.1 * 1.5)); // 1.5x BDP
  });

  test('clamps a huge BDP down to MAX_SEND_WINDOW', () => {
    expect(computeSendWindow(10, { targetRate: 100 * 1024 * 1024 })).toBe(MAX_SEND_WINDOW);
  });

  test('clamps a tiny BDP up to MIN_SEND_WINDOW (a LAN sub-ms RTT never starves a flow)', () => {
    expect(computeSendWindow(0.0005, { targetRate: 8 * 1024 * 1024 })).toBe(MIN_SEND_WINDOW);
  });

  test('grows monotonically with RTT within the clamp band', () => {
    const lo = computeSendWindow(0.05);
    const hi = computeSendWindow(0.15);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThanOrEqual(MIN_SEND_WINDOW);
    expect(hi).toBeLessThanOrEqual(MAX_SEND_WINDOW);
  });

  test('the primary 210ms NL<->South-America relay path reaches the MAX window', () => {
    expect(computeSendWindow(0.21)).toBe(MAX_SEND_WINDOW);
  });

  test('an unknown/invalid RTT falls back to DEFAULT_SEND_WINDOW (matches the pre-adaptive 4 MiB)', () => {
    for (const bad of [null, undefined, 0, -1, NaN, Infinity, 'x']) {
      expect(computeSendWindow(bad)).toBe(DEFAULT_SEND_WINDOW);
    }
  });

  test('the window band can never regress toward the old 256 KB cap', () => {
    // The whole point of the 1.1 fix: 256 KB caps a single flow at ~1.8 MB/s over
    // a 210ms RTT. The adaptive floor must stay well above that.
    expect(MIN_SEND_WINDOW).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_SEND_WINDOW).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    // Kept <=8 MiB: ft-ctrl shares the SCTP association.
    expect(MAX_SEND_WINDOW).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(MIN_SEND_WINDOW).toBeLessThanOrEqual(DEFAULT_SEND_WINDOW);
    expect(DEFAULT_SEND_WINDOW).toBeLessThanOrEqual(MAX_SEND_WINDOW);
  });
});

describe('selectedPairRttSeconds: pull the selected candidate-pair RTT from getStats', () => {
  test('reads the nominated pair currentRoundTripTime (seconds)', () => {
    const entries = [
      { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.21 },
      { type: 'inbound-rtp', kind: 'video' },
    ];
    expect(selectedPairRttSeconds(entries)).toBe(0.21);
  });

  test('prefers a nominated pair over a merely-succeeded one', () => {
    const entries = [
      { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.5 },
      { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.05 },
    ];
    expect(selectedPairRttSeconds(entries)).toBe(0.05);
  });

  test('falls back to a succeeded pair when none is nominated', () => {
    const entries = [{ type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.12 }];
    expect(selectedPairRttSeconds(entries)).toBe(0.12);
  });

  test('returns null when there is no usable pair or no RTT field', () => {
    expect(selectedPairRttSeconds([])).toBe(null);
    expect(selectedPairRttSeconds([{ type: 'candidate-pair', nominated: true }])).toBe(null);
    expect(selectedPairRttSeconds(null)).toBe(null);
  });
});
