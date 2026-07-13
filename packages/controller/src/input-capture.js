// packages/controller/src/input-capture.js
import { INPUT } from '@farsight/shared/input-events';

const BTN = { 0: 'left', 1: 'middle', 2: 'right' };

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
