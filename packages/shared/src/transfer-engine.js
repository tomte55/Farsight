// Pure, resumable transfer state machines for SP3 (spec §6). Tracks per-file
// received/sent counts and status; NO fs (byte counts come from the io layer)
// and NO hashing (the io layer verifies; here we only track status).

export function createReceiveJob({ manifest, have = {} }) {
  const files = new Map();
  for (const e of manifest.entries) {
    const raw = Number.isInteger(have[e.fileId]) && have[e.fileId] > 0 ? have[e.fileId] : 0;
    const got = Math.min(raw, e.size);
    files.set(e.fileId, { size: e.size, received: got, status: got >= e.size ? 'done' : 'pending' });
  }
  function progress() {
    let received = 0, total = 0, filesDone = 0;
    for (const f of files.values()) {
      received += f.received; total += f.size;
      if (f.status === 'done') filesDone += 1;
    }
    return { received, total, fraction: total > 0 ? received / total : 1, filesDone, filesTotal: files.size };
  }
  return {
    resumePlan() {
      return manifest.entries.map((e) => ({ fileId: e.fileId, haveBytes: files.get(e.fileId).received }));
    },
    onFileBegin({ fileId, offset }) {
      const f = files.get(fileId);
      if (!f || !Number.isInteger(offset) || offset < 0 || offset > f.size) return;
      f.received = offset;
      f.status = f.received >= f.size ? 'done' : 'active';
    },
    onBytes(fileId, n) {
      const f = files.get(fileId);
      if (!f || !Number.isInteger(n) || n < 0) return 0;
      f.received = Math.min(f.received + n, f.size);
      if (f.status === 'pending' || f.status === 'active') f.status = 'active';
      return f.size > 0 ? f.received / f.size : 1;
    },
    onFileEnd({ fileId }) { const f = files.get(fileId); if (f) f.status = 'verifying'; },
    markVerified(fileId) { const f = files.get(fileId); if (f) { f.received = f.size; f.status = 'done'; } },
    markFailed(fileId) { const f = files.get(fileId); if (f) { f.received = 0; f.status = 'pending'; } },
    isComplete() { for (const f of files.values()) if (f.status !== 'done') return false; return true; },
    progress,
  };
}

export function createSendJob({ manifest, resume = [] }) {
  const have = new Map();
  for (const r of resume) have.set(r.fileId, r.haveBytes);
  const plan = manifest.entries.map((e) => {
    const start = Math.min(have.get(e.fileId) || 0, e.size);
    return { fileId: e.fileId, size: e.size, offset: start, sent: start >= e.size };
  });
  let idx = 0;
  function advance() { while (idx < plan.length && plan[idx].sent) idx += 1; }
  advance();
  return {
    nextFile() {
      advance();
      if (idx >= plan.length) return null;
      const p = plan[idx];
      return { fileId: p.fileId, offset: p.offset, size: p.size };
    },
    onFileSent(fileId) { const p = plan.find((x) => x.fileId === fileId); if (p) p.sent = true; advance(); },
    isComplete() { return plan.every((p) => p.sent); },
    progress() {
      let total = 0, sent = 0, filesSent = 0;
      for (const p of plan) {
        const rem = p.size - p.offset;
        total += rem;
        if (p.sent) { sent += rem; filesSent += 1; }
      }
      return { sent, total, fraction: total > 0 ? sent / total : 1, filesSent, filesTotal: plan.length };
    },
  };
}

const JOB_TRANSITIONS = {
  active: { pause: 'paused', disconnect: 'interrupted', complete: 'done', fail: 'error', cancel: 'canceled' },
  paused: { resume: 'active', disconnect: 'interrupted', cancel: 'canceled' },
  interrupted: { reconnect: 'active', cancel: 'canceled' },
  done: {},
  error: { retry: 'active', cancel: 'canceled' },
  canceled: {},
};

export function nextJobState(state, event) {
  const t = JOB_TRANSITIONS[state];
  if (!t) return state;
  return t[event] || state;
}
