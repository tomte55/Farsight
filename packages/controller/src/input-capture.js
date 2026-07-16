// packages/controller/src/input-capture.js
import { INPUT } from '@farsight/shared/input-events';

const BTN = { 0: 'left', 1: 'middle', 2: 'right' };

// Verbose diagnostic logging (see docs/private/superpowers): a fixed, static
// message only — NEVER the key value, clipboard text, or event coordinates.
function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

// The video is rendered with `object-fit: contain`, so when the host frame's
// aspect ratio differs from the element box it is letterboxed (black bars on
// the sides or top/bottom). Return the actual rendered video area within the
// element box so coordinates normalize against the live picture, not the bars.
// Falls back to the element box while intrinsic dimensions are still unknown
// (video metadata not yet loaded → videoWidth/videoHeight are 0).
export function videoContentRect(rect, videoWidth, videoHeight) {
  if (!videoWidth || !videoHeight) return rect;
  const boxAspect = rect.width / rect.height;
  const videoAspect = videoWidth / videoHeight;
  if (videoAspect > boxAspect) {
    // Wider than the box: full width, bars top and bottom.
    const height = rect.width / videoAspect;
    return { left: rect.left, top: rect.top + (rect.height - height) / 2, width: rect.width, height };
  }
  // Taller than the box: full height, bars left and right.
  const width = rect.height * videoAspect;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top, width, height: rect.height };
}

export function domEventToInput(e, rect, log = noopLog()) {
  switch (e.type) {
    case 'mousemove':
    case 'mousedown':
    case 'mouseup': {
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) { log.warn('dropped invalid input event'); return null; }
      if (e.type === 'mousemove') return { type: INPUT.MOUSE_MOVE, x, y };
      const button = BTN[e.button];
      if (!button) { log.warn('dropped invalid input event'); return null; }
      return { type: e.type === 'mousedown' ? INPUT.MOUSE_DOWN : INPUT.MOUSE_UP, x, y, button };
    }
    case 'wheel':
      return { type: INPUT.MOUSE_SCROLL, dx: e.deltaX, dy: e.deltaY };
    case 'keydown':
    case 'keyup': {
      // A malformed/synthetic key event with no key value is not actionable —
      // drop it. The warn is a fixed string; it never embeds e.key.
      if (typeof e.key !== 'string' || e.key === '') { log.warn('dropped invalid input event'); return null; }
      return { type: e.type === 'keydown' ? INPUT.KEY_DOWN : INPUT.KEY_UP, key: e.key };
    }
    default:
      log.warn('dropped invalid input event');
      return null;
  }
}
