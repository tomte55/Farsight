// packages/controller/src/input-capture.js
import { INPUT } from '@farsight/shared/input-events';

const BTN = { 0: 'left', 1: 'middle', 2: 'right' };

export function domEventToInput(e, rect) {
  switch (e.type) {
    case 'mousemove':
    case 'mousedown':
    case 'mouseup': {
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      if (e.type === 'mousemove') return { type: INPUT.MOUSE_MOVE, x, y };
      const button = BTN[e.button];
      if (!button) return null;
      return { type: e.type === 'mousedown' ? INPUT.MOUSE_DOWN : INPUT.MOUSE_UP, x, y, button };
    }
    case 'wheel':
      return { type: INPUT.MOUSE_SCROLL, dx: e.deltaX, dy: e.deltaY };
    case 'keydown':
      return { type: INPUT.KEY_DOWN, key: e.key };
    case 'keyup':
      return { type: INPUT.KEY_UP, key: e.key };
    default:
      return null;
  }
}
