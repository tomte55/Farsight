// packages/controller/test/consent-overlay-css.test.js
// Guard: the inbound-consent card must paint ABOVE its sibling .veil.
//
// The consent modal reuses .overlay/.veil/.card from farsight.css:
//   <div class="overlay"><div class="veil"></div><div class="card attn">…</div></div>
// .veil is position:absolute with backdrop-filter:blur + a semi-opaque bg; the
// card is a grid child. In CSS painting order a positioned element (.veil) paints
// ON TOP of a non-positioned in-flow sibling (a static .card), so the veil would
// blur the card AND intercept every click on Allow/Deny — the window looks
// blurred and the buttons are dead. The in-session .toast avoids this by being
// position:relative; the consent card needs the same, or it is unusable.
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(__dirname, '../src/renderer/shell.css'), 'utf8');

function ruleBody(source, selector) {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = noComments.indexOf(selector);
  if (idx === -1) return null;
  const open = noComments.indexOf('{', idx);
  const close = noComments.indexOf('}', open);
  if (open === -1 || close === -1) return null;
  return noComments.slice(open + 1, close);
}

// Both consent overlays (control Allow/Deny AND incoming-transfer Accept/Reject)
// reuse .overlay/.veil/.card and hit the same painting bug — guard both.
for (const selector of ['#consent .card', '#transfer-consent .card']) {
  test(`${selector} is positioned so it paints above the blurred .veil`, () => {
    const body = ruleBody(css, selector);
    expect(body, `no ${selector} rule found in shell.css`).not.toBeNull();
    const pos = (body.match(/position\s*:\s*([a-z]+)/) || [])[1];
    expect(
      pos,
      `${selector} must set position:relative (or another non-static value) — otherwise the absolutely-positioned .veil paints over it, blurring the prompt and eating clicks on its buttons`,
    ).toBeDefined();
    expect(pos).not.toBe('static');
  });
}
