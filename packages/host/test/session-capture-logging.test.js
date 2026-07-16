// packages/host/test/session-capture-logging.test.js
import { expect, test } from 'vitest';
import { createSession } from '../src/session.js';
import { monitorsForControl, captureScreenStream } from '../src/capture.js';

function makeLog() {
  const calls = [];
  const mk = () => ({
    debug: (m) => calls.push(`debug:${m}`),
    info: (m) => calls.push(`info:${m}`),
    warn: (m) => calls.push(`warn:${m}`),
    error: (m) => calls.push(`error:${m}`),
    child: () => mk(),
  });
  return { log: mk(), calls };
}

test('session logs "session started" on allow() and "session stopped" on end()', () => {
  const { log, calls } = makeLog();
  const s = createSession({ onStateChange: () => {}, log });
  s.requestConsent();
  s.allow();
  expect(calls.join('\n')).toMatch(/session started/);
  s.end();
  expect(calls.join('\n')).toMatch(/session stopped/);
});

test('session with no log option still works (default no-op logger)', () => {
  const s = createSession({ onStateChange: () => {} });
  s.requestConsent();
  s.allow();
  expect(s.isActive()).toBe(true);
  s.end();
  expect(s.state).toBe('idle');
});

test('deny() does not log "session started"', () => {
  const { log, calls } = makeLog();
  const s = createSession({ onStateChange: () => {}, log });
  s.requestConsent();
  s.deny();
  expect(calls.join('\n')).not.toMatch(/session started/);
});

test('monitorsForControl logs the monitor count at info', () => {
  const { log, calls } = makeLog();
  const displays = [
    { index: 0, label: 'Main', width: 1920, height: 1080, primary: true },
    { index: 1, label: 'Side', width: 1280, height: 720, primary: false },
  ];
  const out = monitorsForControl(displays, log);
  expect(out).toHaveLength(2);
  expect(calls.join('\n')).toMatch(/info:monitors=2/);
});

test('monitorsForControl with no log option still works (default no-op logger)', () => {
  const displays = [{ index: 0, label: 'Main', width: 1920, height: 1080, primary: true }];
  expect(monitorsForControl(displays)).toEqual([
    { index: 0, label: 'Main', width: 1920, height: 1080, primary: true },
  ]);
});

test('captureScreenStream logs chosen resolution and monitor, never pixel/frame data', async () => {
  const { log, calls } = makeLog();
  const desktopCapturer = {
    getSources: async () => [{ id: 'screen:1', display_id: '10' }],
  };
  const screen = { getPrimaryDisplay: () => ({ id: 10 }) };
  const fakeTrack = { getSettings: () => ({ width: 1920, height: 1080 }) };
  const fakeStream = { getVideoTracks: () => [fakeTrack] };
  const navigatorMediaDevices = { getUserMedia: async () => fakeStream };

  const stream = await captureScreenStream(desktopCapturer, screen, navigatorMediaDevices, log);

  expect(stream).toBe(fakeStream);
  const joined = calls.join('\n');
  expect(joined).toMatch(/info:capture 1920x1080 monitor=10/);
  // Never a data URL / base64 blob / raw pixel payload.
  expect(joined).not.toMatch(/data:image|base64/i);
});

test('captureScreenStream with no log option still works (default no-op logger)', async () => {
  const desktopCapturer = { getSources: async () => [{ id: 'screen:1', display_id: '10' }] };
  const screen = { getPrimaryDisplay: () => ({ id: 10 }) };
  const fakeStream = { getVideoTracks: () => [] };
  const navigatorMediaDevices = { getUserMedia: async () => fakeStream };
  const stream = await captureScreenStream(desktopCapturer, screen, navigatorMediaDevices);
  expect(stream).toBe(fakeStream);
});
