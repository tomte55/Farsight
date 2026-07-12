// packages/host/src/capture.js
// Pure helper — no Electron import so it is unit-testable.
export function pickPrimaryScreen(sources, primaryDisplayId) {
  if (!sources || sources.length === 0) return undefined;
  return sources.find((s) => String(s.display_id) === String(primaryDisplayId)) ?? sources[0];
}

// Runtime helper (used by the renderer, exercised via manual verification).
export async function captureScreenStream(desktopCapturer, screen, navigatorMediaDevices) {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const primaryId = screen.getPrimaryDisplay().id;
  const source = pickPrimaryScreen(sources, primaryId);
  return navigatorMediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxFrameRate: 30,
      },
    },
  });
}

export function listDisplays(screen) {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, index) => ({
    index, id: d.id, label: d.label || `Display ${index + 1}`,
    width: d.size.width, height: d.size.height,
    bounds: d.bounds, scaleFactor: d.scaleFactor,
    primary: d.id === primaryId,
  }));
}

export function displaySourceId(sources, display) {
  const byId = sources.find((s) => String(s.display_id) === String(display.id));
  return (byId ?? sources[display.index] ?? sources[0])?.id;
}

export function monitorsForControl(displays) {
  return displays.map((d) => ({ index: d.index, label: d.label, width: d.width, height: d.height, primary: d.primary }));
}
