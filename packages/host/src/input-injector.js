// packages/host/src/input-injector.js
import { validateInputEvent, INPUT } from '@farsight/shared/input-events';

export function createInjector({ nut, display, dipToScreen = (p) => p }) {
  let region = display.bounds;
  const toScreen = (x, y) => {
    const dip = { x: Math.round(region.x + x * region.width), y: Math.round(region.y + y * region.height) };
    return dipToScreen(dip);
  };
  // Native nut.js calls are async. Serialize them through a promise chain so
  // each event's native ops complete before the next event's native ops
  // start — otherwise a rapid burst can apply out of order (cursor
  // jitter/backtrack). A rejected nut call must never break the chain for
  // subsequent events.
  let chain = Promise.resolve();
  const enqueue = (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };
  return {
    setDisplay(next) { region = next.bounds; },
    inject(rawEvent) {
      let evt;
      try { evt = validateInputEvent(rawEvent); } catch { return false; }
      switch (evt.type) {
        case INPUT.MOUSE_MOVE: { const p = toScreen(evt.x, evt.y); enqueue(() => nut.moveMouse(p.x, p.y)); break; }
        case INPUT.MOUSE_DOWN: { const p = toScreen(evt.x, evt.y); enqueue(async () => { await nut.moveMouse(p.x, p.y); await nut.mouseDown(evt.button); }); break; }
        case INPUT.MOUSE_UP: { const p = toScreen(evt.x, evt.y); enqueue(async () => { await nut.moveMouse(p.x, p.y); await nut.mouseUp(evt.button); }); break; }
        case INPUT.MOUSE_SCROLL: enqueue(() => nut.scroll(evt.dx, evt.dy)); break;
        case INPUT.KEY_DOWN: enqueue(() => nut.keyDown(evt.key)); break;
        case INPUT.KEY_UP: enqueue(() => nut.keyUp(evt.key)); break;
      }
      return true;
    },
  };
}
