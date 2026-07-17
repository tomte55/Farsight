// packages/host/test/nut-facade.test.js
// Pins the auto-delay config the facade MUST apply to nut.js.
//
// nut.js ships non-zero auto-delays: KeyboardClass defaults to `autoDelayMs: 300`
// and awaits `sleep(autoDelayMs)` BEFORE every pressKey/releaseKey and before every
// char in type(). MouseClass defaults to 100 but its constructor hardcodes
// setMouseDelay(0) and setPosition never sleeps — which is why an unconfigured
// keyboard lags while the mouse stays snappy. The injector serializes every event
// through one promise chain, so those sleeps don't just add latency per key, they
// back the queue up under sustained typing.
//
// The mocks below reproduce the real classes' delay semantics (verified against
// node_modules/@nut-tree-fork/nut-js/dist/lib/{keyboard,mouse}.class.js) so these
// tests fail if the facade stops zeroing the delay.
import { expect, test, vi, beforeEach } from 'vitest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real nut.js defaults — the state the facade inherits at import time.
const mouse = { config: { autoDelayMs: 100, mouseSpeed: 1000 } };
const keyboard = { config: { autoDelayMs: 300 } };

vi.mock('@nut-tree-fork/nut-js', () => ({
  mouse,
  keyboard,
  Button: { LEFT: 'LEFT', RIGHT: 'RIGHT', MIDDLE: 'MIDDLE' },
  Key: { Enter: 'Enter', Backspace: 'Backspace', LeftShift: 'LeftShift' },
  Point: class { constructor(x, y) { this.x = x; this.y = y; } },
}));

const { createNutFacade } = await import('../src/nut-facade.js');

beforeEach(() => {
  // Restore the shipped defaults before each test so one test can't mask another.
  mouse.config.autoDelayMs = 100;
  keyboard.config.autoDelayMs = 300;
  // Model the real classes: each op awaits sleep(config.autoDelayMs) first.
  keyboard.pressKey = vi.fn(async () => { await sleep(keyboard.config.autoDelayMs); });
  keyboard.releaseKey = vi.fn(async () => { await sleep(keyboard.config.autoDelayMs); });
  keyboard.type = vi.fn(async () => { await sleep(keyboard.config.autoDelayMs); });
  mouse.setPosition = vi.fn(async () => {});
});

test('zeroes the keyboard auto-delay (nut.js defaults to a 300ms sleep before every key op)', () => {
  createNutFacade();
  expect(keyboard.config.autoDelayMs).toBe(0);
});

test('zeroes the mouse auto-delay', () => {
  createNutFacade();
  expect(mouse.config.autoDelayMs).toBe(0);
});

test('a printable keystroke injects without nut.js\'s default 300ms stall', async () => {
  const nut = createNutFacade();
  const started = Date.now();
  await nut.keyDown('a'); // unmapped printable -> keyboard.type()
  expect(Date.now() - started).toBeLessThan(50);
});

test('a mapped key down/up pair injects without stalling (300ms each by default)', async () => {
  const nut = createNutFacade();
  const started = Date.now();
  await nut.keyDown('Enter'); // mapped -> pressKey
  await nut.keyUp('Enter');   // mapped -> releaseKey
  expect(Date.now() - started).toBeLessThan(50);
});
