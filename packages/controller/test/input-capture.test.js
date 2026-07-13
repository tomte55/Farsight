// packages/controller/test/input-capture.test.js
import { expect, test } from 'vitest';
import { domEventToInput, videoContentRect } from '../src/input-capture.js';
import { INPUT } from '@farsight/shared/input-events';

const rect = { left: 100, top: 50, width: 800, height: 600 };

test('mousemove maps to fractional coords', () => {
  const out = domEventToInput({ type: 'mousemove', clientX: 500, clientY: 350 }, rect);
  expect(out).toEqual({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.5 });
});

test('mousedown maps button 0 to left', () => {
  const out = domEventToInput({ type: 'mousedown', clientX: 100, clientY: 50, button: 0 }, rect);
  expect(out).toEqual({ type: INPUT.MOUSE_DOWN, x: 0, y: 0, button: 'left' });
});

test('coords outside the video are ignored', () => {
  expect(domEventToInput({ type: 'mousemove', clientX: 0, clientY: 0 }, rect)).toBeNull();
});

test('keydown maps key', () => {
  expect(domEventToInput({ type: 'keydown', key: 'a' }, rect)).toEqual({ type: INPUT.KEY_DOWN, key: 'a' });
});

// object-fit: contain letterboxes the video inside the element box whenever the
// host frame aspect ratio differs from the element aspect ratio. videoContentRect
// returns the actual rendered video area so coordinates normalize against it, not
// the full element box (which would count the black bars as live screen area).
const box = { left: 0, top: 0, width: 800, height: 600 }; // 4:3

test('content rect equals element box when aspect ratios match', () => {
  expect(videoContentRect(box, 1600, 1200)).toEqual(box);
});

test('wider video letterboxes with top/bottom bars', () => {
  // 1920x1080 (16:9) inside a 4:3 box: constrained by width, height shrinks.
  expect(videoContentRect(box, 1920, 1080)).toEqual({ left: 0, top: 75, width: 800, height: 450 });
});

test('taller video pillarboxes with left/right bars', () => {
  // 1080x1920 (9:16) inside a 4:3 box: constrained by height, width shrinks.
  expect(videoContentRect(box, 1080, 1920)).toEqual({ left: 231.25, top: 0, width: 337.5, height: 600 });
});

test('falls back to element box when video size is unknown', () => {
  expect(videoContentRect(box, 0, 0)).toEqual(box);
});

test('center of a letterboxed video maps to 0.5,0.5', () => {
  // A wider video centered vertically in the box: content spans y=[75,525],
  // so the box's vertical center (y=300) is the video's true center.
  const content = videoContentRect(box, 1920, 1080);
  const out = domEventToInput({ type: 'mousemove', clientX: 400, clientY: 300 }, content);
  expect(out).toEqual({ type: INPUT.MOUSE_MOVE, x: 0.5, y: 0.5 });
});

test('clicks in the letterbox bars are ignored', () => {
  // y=30 is inside the top black bar (bar spans y=[0,75]).
  const content = videoContentRect(box, 1920, 1080);
  expect(domEventToInput({ type: 'mousemove', clientX: 400, clientY: 30 }, content)).toBeNull();
});
