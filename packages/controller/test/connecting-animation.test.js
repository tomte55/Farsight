// packages/controller/test/connecting-animation.test.js
// Guard: the in-flight connect/reconnect overlay shows an ANIMATED three-dot
// indicator (positive "not frozen" feedback), not a static "…". Source-text
// guards in the project's style (vitest environment:'node', no DOM render).
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const js = readFileSync(resolve(__dirname, '../src/session-window/session.js'), 'utf8');
const css = readFileSync(resolve(__dirname, '../src/session-window/session.css'), 'utf8');

describe('connecting animation', () => {
  test('session.css defines animated .ov-dots driven by a keyframe animation', () => {
    expect(css).toMatch(/\.ov-dots\b/);
    // The dots must actually animate — a keyframes rule the .ov-dots dots use.
    expect(css).toMatch(/@keyframes\s+ov-dot-pulse/);
    const dotRule = css.slice(css.indexOf('.ov-dots i'));
    expect(dotRule).toMatch(/animation\s*:[^;]*ov-dot-pulse/);
  });

  test('the dots are staggered so the wave is visible, not three dots blinking as one', () => {
    expect(css).toMatch(/\.ov-dots i:nth-child\(2\)[^}]*animation-delay/);
    expect(css).toMatch(/\.ov-dots i:nth-child\(3\)[^}]*animation-delay/);
  });

  test('showConnecting renders the animated dots, not a static ellipsis glyph', () => {
    const fn = js.slice(js.indexOf('function showConnecting('), js.indexOf('function showConnecting(') + 300);
    expect(fn).toContain('setGlyphConnecting(');
    // It must NOT fall back to writing a literal "…" into the glyph itself.
    expect(fn).not.toMatch(/ov-glyph'\)\.textContent\s*=\s*'…'/);
  });

  test('setGlyphConnecting builds three dot elements inside the glyph circle', () => {
    const fn = js.slice(js.indexOf('function setGlyphConnecting('), js.indexOf('function setGlyphConnecting(') + 400);
    expect(fn).toContain("'ov-dots'");
    expect(fn).toMatch(/i\s*<\s*3/); // three dots
    expect(fn).toContain("createElement('i')");
  });

  test('the reconnecting/connecting overlay states also use the animated dots', () => {
    const fn = js.slice(js.indexOf('function showOverlay('), js.indexOf('function showConnecting('));
    expect(fn).toContain('setGlyphConnecting(');
    expect(fn).toMatch(/reconnecting'\s*\|\|\s*o\.kind\s*===\s*'connecting'|connecting'\s*\|\|\s*o\.kind\s*===\s*'reconnecting'/);
  });
});
