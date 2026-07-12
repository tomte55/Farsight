// packages/host/test/tray-menu.test.js
import { expect, test, vi } from 'vitest';
import { buildTrayMenuTemplate } from '../src/tray-menu.js';

test('builds Show / credentials / Quit with wired callbacks', () => {
  const onShow = vi.fn();
  const onQuit = vi.fn();
  const t = buildTrayMenuTemplate({ id: '410 682 937', password: 'k7m2-9xqp-4vwt', onShow, onQuit });

  const labels = t.map((i) => i.label).filter(Boolean);
  expect(labels).toEqual([
    'Show Farsight',
    'ID: 410 682 937',
    'Password: k7m2-9xqp-4vwt',
    'Quit',
  ]);

  // Credential rows are display-only.
  expect(t.find((i) => i.label === 'ID: 410 682 937').enabled).toBe(false);
  expect(t.find((i) => i.label === 'Password: k7m2-9xqp-4vwt').enabled).toBe(false);

  // Separators present between groups.
  expect(t.filter((i) => i.type === 'separator').length).toBe(2);

  t.find((i) => i.label === 'Show Farsight').click();
  t.find((i) => i.label === 'Quit').click();
  expect(onShow).toHaveBeenCalledOnce();
  expect(onQuit).toHaveBeenCalledOnce();
});

test('shows placeholders before the id is registered', () => {
  const t = buildTrayMenuTemplate({ id: '', password: 'k7m2-9xqp-4vwt', onShow() {}, onQuit() {} });
  expect(t.find((i) => i.label && i.label.startsWith('ID:')).label).toBe('ID: —');
});
