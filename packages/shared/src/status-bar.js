// packages/shared/src/status-bar.js
// Pure model for the main window's persistent bottom status bar (unification step 1).
// Runtime-agnostic — no DOM, no node: imports — so it unit-tests in isolation and is
// safe to import from the sandboxed renderer via the import map.
//
// The bar is the app's always-on overview: it absorbs what used to be three separate
// fixed-bottom elements (#update-banner, #version-tag, and — from step 3 — the host's
// #panic-warning), all of which pinned to bottom:0 and would otherwise collide.
import { formatBytes, formatRate, formatDuration, etaSeconds, bytesDone } from './transfer-rate.js';

const TERMINAL = ['done', 'canceled', 'error', 'declined'];

const SIGNALING_TEXT = {
  connecting: { text: 'Connecting to signaling…', dot: 'acc' },
  ready: { text: 'Ready', dot: 'acc' },
  error: { text: 'Signaling unavailable', dot: 'warn' },
};

function seg(id, kind, text, { dot = null, bar = null, focus = null } = {}) {
  return { id, kind, text, dot, bar, focus };
}

function sessionDetail(s) {
  const parts = [];
  if (Number.isFinite(s.rttMs)) parts.push(`${s.rttMs} ms`);
  if (Number.isFinite(s.width) && Number.isFinite(s.height)) parts.push(`${s.width}×${s.height}`);
  if (s.transport) parts.push(s.transport);
  return parts.join(' · ');
}

function transferText(j) {
  const arrow = j.direction === 'recv' ? '↓' : '↑';
  const p = j.progress;
  const head = `${arrow} ${j.peer || 'Unknown peer'}`;
  if (!p || !Number.isFinite(p.total) || p.total <= 0) return head;
  const done = bytesDone(p);
  const parts = [`${formatBytes(done)} of ${formatBytes(p.total)}`];
  if (Number.isFinite(j.rate) && j.rate > 0) {
    parts.push(formatRate(j.rate));
    // Only an actively-moving job has a meaningful ETA — an interrupted one would
    // extrapolate from a rate that has stopped applying.
    const eta = etaSeconds(p.total - done, j.rate);
    if (eta !== null && j.state === 'active') parts.push(`~${formatDuration(eta)} left`);
  }
  return `${head} · ${parts.join(' · ')}`;
}

function transferBar(j) {
  const p = j.progress;
  if (!p || !Number.isFinite(p.total) || p.total <= 0) return null;
  return Math.min(1, Math.max(0, bytesDone(p) / p.total));
}

export function buildStatusSegments(state = {}) {
  const { signaling = 'connecting', signedInAs = null, session = null, transfers = [], update = null, appVersion = null } = state || {};
  const out = [];

  const sig = SIGNALING_TEXT[signaling] || SIGNALING_TEXT.connecting;
  out.push(seg('state', 'state', sig.text, { dot: sig.dot }));

  if (signedInAs) out.push(seg('account', 'account', `Signed in as ${signedInAs}`));

  if (session && session.peer) {
    out.push(seg('session', 'session', `Connected to ${session.peer}`, { dot: 'acc2', focus: 'session' }));
    const detail = sessionDetail(session);
    if (detail) out.push(seg('session-detail', 'session', detail));
  }

  for (const j of Array.isArray(transfers) ? transfers : []) {
    if (!j || TERMINAL.includes(j.state)) continue;
    out.push(seg(`transfer:${j.jobId}`, 'transfer', transferText(j), { bar: transferBar(j), focus: 'transfers' }));
  }

  if (update) {
    const v = update.version ? ` (${update.version})` : '';
    out.push(seg('update', 'warn', `Update ready${v} — restart to install`, { dot: 'warn', focus: 'install-update' }));
  }

  if (appVersion) out.push(seg('version', 'version', `v${appVersion}`));

  return out;
}
