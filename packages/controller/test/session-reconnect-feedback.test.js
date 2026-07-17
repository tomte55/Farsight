// packages/controller/test/session-reconnect-feedback.test.js
// The session window's #status element is hidden, so connect/reconnect status and
// errors must surface on the overlay (position:fixed over the video) instead — or
// a failed Reconnect looks like the button did nothing. Guards that wiring.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(__dirname, '../src/session-window/session.js'), 'utf8');

describe('session reconnect feedback', () => {
  test('a connect/reconnect failure is shown on the overlay with a retry, not a hidden #status', () => {
    expect(js).toMatch(/function showConnectError\(/);
    // the offered actions must include a reconnect (retry) and a close
    const fn = js.slice(js.indexOf('function showConnectError('));
    expect(fn).toContain("id: 'reconnect'");
    expect(fn).toContain('doReconnect');
  });

  test('the signaling MSG.ERROR path surfaces the error via showConnectError', () => {
    // Both the linked bad_password branch and the generic terminal branch must call it.
    const errBlock = js.slice(js.indexOf('[MSG.ERROR]'), js.indexOf('[MSG.PEER_DISCONNECTED]'));
    expect((errBlock.match(/showConnectError\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('reconnect gives immediate on-screen feedback, not just a dismissed overlay', () => {
    const dr = js.slice(js.indexOf('function doReconnect('), js.indexOf("function doReconnect(") + 900);
    expect(dr).toContain('showConnecting(');
    expect(dr).toContain('connectTo(');
  });

  test('a successful connection clears the overlay', () => {
    const rs = js.slice(js.indexOf('function revealSession('), js.indexOf('function revealSession(') + 400);
    expect(rs).toContain('overlayEl.hidden = true');
  });
});
