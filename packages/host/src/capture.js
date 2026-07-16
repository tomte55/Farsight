// packages/host/src/capture.js
// Verbose diagnostic logging (see docs/private/superpowers): resolution/monitor
// counts and ids only — never frame/pixel data.
function noopLog() { const n = { debug() {}, info() {}, warn() {}, error() {}, child: () => n }; return n; }

// Pure helper — no Electron import so it is unit-testable.
export function pickPrimaryScreen(sources, primaryDisplayId) {
  if (!sources || sources.length === 0) return undefined;
  return sources.find((s) => String(s.display_id) === String(primaryDisplayId)) ?? sources[0];
}

// Runtime helper (used by the renderer, exercised via manual verification).
export async function captureScreenStream(desktopCapturer, screen, navigatorMediaDevices, log = noopLog()) {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const primaryId = screen.getPrimaryDisplay().id;
  const source = pickPrimaryScreen(sources, primaryId);
  const stream = await navigatorMediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxFrameRate: 30,
      },
    },
  });
  const track = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks()[0] : undefined;
  const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : undefined;
  const w = settings?.width ?? '?';
  const h = settings?.height ?? '?';
  log.info(`capture ${w}x${h} monitor=${primaryId}`);
  return stream;
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

export function monitorsForControl(displays, log = noopLog()) {
  const monitors = displays.map((d) => ({ index: d.index, label: d.label, width: d.width, height: d.height, primary: d.primary }));
  log.info(`monitors=${monitors.length}`);
  return monitors;
}
