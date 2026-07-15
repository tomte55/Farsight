import { describe, it, expect } from 'vitest';
import { parseDtlsFingerprint, buildTranscript } from '../src/connect-transcript.js';

const SDP = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=fingerprint:sha-256 AA:BB:CC:DD',
  'a=setup:actpass',
].join('\r\n');

describe('connect-transcript', () => {
  it('parses the DTLS fingerprint from SDP (uppercased)', () => {
    expect(parseDtlsFingerprint(SDP)).toBe('AA:BB:CC:DD');
    expect(parseDtlsFingerprint(SDP.toLowerCase())).toBe('AA:BB:CC:DD');
  });

  it('returns null when no fingerprint line is present', () => {
    expect(parseDtlsFingerprint('v=0\r\ns=-')).toBe(null);
    expect(parseDtlsFingerprint('')).toBe(null);
    expect(parseDtlsFingerprint(null)).toBe(null);
  });

  it('builds an identical transcript regardless of field object order', () => {
    const a = buildTranscript({ ctrlDeviceId: 'c', hostDeviceId: 'h', ctrlFingerprint: 'AA', hostFingerprint: 'BB', nonceC: 'n1', nonceH: 'n2' });
    const b = buildTranscript({ nonceH: 'n2', hostFingerprint: 'BB', hostDeviceId: 'h', nonceC: 'n1', ctrlFingerprint: 'AA', ctrlDeviceId: 'c' });
    expect(a).toBe(b);
  });

  it('changes the transcript if any binding field changes', () => {
    const base = { ctrlDeviceId: 'c', hostDeviceId: 'h', ctrlFingerprint: 'AA', hostFingerprint: 'BB', nonceC: 'n1', nonceH: 'n2' };
    const t = buildTranscript(base);
    expect(buildTranscript({ ...base, hostFingerprint: 'ZZ' })).not.toBe(t);
    expect(buildTranscript({ ...base, nonceC: 'x' })).not.toBe(t);
  });
});
