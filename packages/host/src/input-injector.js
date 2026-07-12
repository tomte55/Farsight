// packages/host/src/input-injector.js
import { validateInputEvent, INPUT } from '@farsight/shared/input-events';

export function createInjector({ nut, display, dipToScreen = (p) => p }) {
  let region = display.bounds;
  const toScreen = (x, y) => {
    const dip = { x: Math.round(region.x + x * region.width), y: Math.round(region.y + y * region.height) };
    return dipToScreen(dip);
  };
  return {
    setDisplay(next) { region = next.bounds; },
    inject(rawEvent) {
      let evt;
      try { evt = validateInputEvent(rawEvent); } catch { return false; }
      switch (evt.type) {
        case INPUT.MOUSE_MOVE: { const p = toScreen(evt.x, evt.y); nut.moveMouse(p.x, p.y); break; }
        case INPUT.MOUSE_DOWN: { const p = toScreen(evt.x, evt.y); nut.moveMouse(p.x, p.y); nut.mouseDown(evt.button); break; }
        case INPUT.MOUSE_UP: { const p = toScreen(evt.x, evt.y); nut.moveMouse(p.x, p.y); nut.mouseUp(evt.button); break; }
        case INPUT.MOUSE_SCROLL: nut.scroll(evt.dx, evt.dy); break;
        case INPUT.KEY_DOWN: nut.keyDown(evt.key); break;
        case INPUT.KEY_UP: nut.keyUp(evt.key); break;
      }
      return true;
    },
  };
}
