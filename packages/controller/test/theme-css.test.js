// packages/controller/test/theme-css.test.js
// Guard: the renderer must link the vendored Aurora stylesheet via the
// packaging-safe ../shared/*.css path (same reasoning as importmap.test.js —
// ../shared/ resolves identically in dev and in the packaged asar).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../src/renderer/index.html'), 'utf8');

test('renderer links farsight.css via the packaging-safe ../shared path', () => {
  const m = html.match(/<link[^>]+href="([^"]+farsight\.css)"/);
  expect(m).not.toBeNull();
  expect(m[1]).toBe('../shared/farsight.css');
  expect(existsSync(resolve(__dirname, '../../shared/src/farsight.css'))).toBe(true);
});

// Build the set of exact compound-selector tokens the stylesheet defines, so a
// contract check can assert a selector is a real rule HEAD rather than merely a
// substring of some other selector (`.shell` is a substring of `.shell-body`,
// `.card` is a substring of `.card.attn`, etc. — plain `toContain` is vacuous for
// all of these). Comments are stripped first: this file has prose that names
// classes inline (e.g. "fleet rendered .host-dot without the .on class"), and
// without stripping, a deleted rule's name can survive as comment text glued to
// the next rule's captured selector text, producing a false "still defined".
//
// NOTE: a plausible simpler fix — matching `sel` as a whole token via
// `(^|[\s,])sel(?![\w-])` over the raw pre-brace text — was tried and rejected.
// It correctly separates `.shell`/`.shell-body` (next char `-` is excluded by
// the lookahead), but it does NOT catch `.card` vs `.card.attn`: the character
// right after `.card` in `.card.attn` is `.`, which the `[\w-]` lookahead does
// not exclude, so `.card` still matches even after the bare `.card` rule is
// deleted. Verified by mutation-testing that regex directly against this file
// before writing the version below.
function definedSelectors(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Set();
  for (const rule of noComments.matchAll(/([^{}]+)\{/g)) {
    for (const rawSelector of rule[1].split(',')) {
      const selector = rawSelector.trim();
      if (!selector) continue;
      for (const token of selector.split(/\s+/)) {
        if (token === '>' || token === '+' || token === '~' || token === '') continue;
        tokens.add(token);
      }
    }
  }
  return tokens;
}

test('the shared Aurora stylesheet defines the shell primitives the rail markup needs', () => {
  const css = readFileSync(resolve(__dirname, '../../shared/src/farsight.css'), 'utf8');
  const defined = definedSelectors(css);
  const contract = [
    '.shell', '.shell-body',
    '.rail', '.rail-item', '.rail-item.sel', '.rail-icon', '.rail-badge', '.rail-gap',
    '.pane', '.page', '.page[hidden]', '.page-head', '.page-title', '.page-sub',
    '.statusbar', '.sb-seg', '.sb-div', '.sb-spring',
    '.sb-dot', '.sb-dot.acc', '.sb-dot.acc2', '.sb-dot.warn',
    '.sb-bar', '.sb-bar-fill', '.sb-strong', '.sb-ver',
    '.row-actions', '.stack',
    '.host-row', '.host-dot', '.host-main', '.host-name', '.host-meta', '.host-right',
    '.host-status', '.host-badge', '.fleet-empty',
    '.xfer-row', '.xfer-bar', '.xfer-bar-fill',
    '.linkbtn', '.acct-links', '.acct-opt',
    '.u-full', '.u-flex1', '.u-row', '.u-danger', '.u-ok', '.u-tight', '.u-mb16', '.u-hidden',
  ];
  for (const sel of contract) {
    expect(defined.has(sel), `farsight.css must define a rule for ${sel} (found only as part of another selector, or not at all)`).toBe(true);
  }
});

test('the shell primitives are additive — the host renderer still gets its existing selectors', () => {
  const css = readFileSync(resolve(__dirname, '../../shared/src/farsight.css'), 'utf8');
  const defined = definedSelectors(css);
  // packages/host is frozen in unification step 1 and links this same stylesheet.
  const contract = [
    '.wm', '.lbl', '.chip', '.pill', '.btn', '.input', '.card', '.statusline',
    '.sessionbar', '.overlay', '.veil', '.toast', '.cog', '.menu',
  ];
  for (const sel of contract) {
    expect(defined.has(sel), `farsight.css must keep a rule for ${sel} for the frozen host (found only as part of another selector, or not at all)`).toBe(true);
  }
});
