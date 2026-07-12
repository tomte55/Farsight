// packages/shared/src/input-events.js
export const INPUT = Object.freeze({
  MOUSE_MOVE: 'mousemove',
  MOUSE_DOWN: 'mousedown',
  MOUSE_UP: 'mouseup',
  MOUSE_SCROLL: 'scroll',
  KEY_DOWN: 'keydown',
  KEY_UP: 'keyup',
});

export const BUTTONS = Object.freeze(new Set(['left', 'right', 'middle']));

const NAMED_KEYS = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', ' ',
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

const PRINTABLE = /^[\w .,;:'"/\\<>?!@#$%^&*()\-=[\]{}|`~+]$/;

const fail = () => { throw new Error('invalid input event'); };
const isFrac = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const isFiniteBounded = (n, lim) => typeof n === 'number' && Number.isFinite(n) && n >= -lim && n <= lim;

export function validateInputEvent(evt) {
  if (!evt || typeof evt !== 'object') fail();
  switch (evt.type) {
    case INPUT.MOUSE_MOVE:
      if (!isFrac(evt.x) || !isFrac(evt.y)) fail();
      return { type: evt.type, x: evt.x, y: evt.y };
    case INPUT.MOUSE_DOWN:
    case INPUT.MOUSE_UP:
      if (!isFrac(evt.x) || !isFrac(evt.y) || !BUTTONS.has(evt.button)) fail();
      return { type: evt.type, x: evt.x, y: evt.y, button: evt.button };
    case INPUT.MOUSE_SCROLL:
      if (!isFiniteBounded(evt.dx, 10000) || !isFiniteBounded(evt.dy, 10000)) fail();
      return { type: evt.type, dx: evt.dx, dy: evt.dy };
    case INPUT.KEY_DOWN:
    case INPUT.KEY_UP:
      if (typeof evt.key !== 'string' || evt.key.length < 1 || evt.key.length > 32) fail();
      if (!NAMED_KEYS.has(evt.key) && !(evt.key.length === 1 && PRINTABLE.test(evt.key))) fail();
      return { type: evt.type, key: evt.key };
    default:
      return fail();
  }
}
