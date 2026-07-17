import { describe, it, expect } from 'vitest';
import { createSendPool } from '../src/transfer-send-pool.js';
import { decodeBulkFrame } from '../src/transfer-chunk.js';

// A fake flow that records frames; `slowEveryN` delays to force load imbalance.
function fakeFlow({ alive = true } = {}) {
  const sent = [];
  let live = alive;
  return {
    sent,
    kill() { live = false; },
    isAlive: () => live,
    sendBulk: (buf) => { if (!live) return Promise.reject(new Error('dead')); sent.push(decodeBulkFrame(buf)); return Promise.resolve(); },
  };
}

async function* chunks(n) {
  for (let i = 0; i < n; i++) yield { fileId: 0, offset: i * 4, length: 4, payload: new Uint8Array([i, i, i, i]) };
}

describe('transfer-send-pool', () => {
  it('delivers every chunk exactly once across flows', async () => {
    const flows = [fakeFlow(), fakeFlow(), fakeFlow()];
    await createSendPool({ flows }).run(chunks(30));
    const all = flows.flatMap((f) => f.sent).map((c) => c.offset).sort((a, b) => a - b);
    expect(all).toEqual([...Array(30)].map((_, i) => i * 4));
  });

  it('requeues a dead flow\'s chunk onto a live flow', async () => {
    const good = fakeFlow();
    const bad = fakeFlow();
    bad.kill(); // rejects every send
    const pool = createSendPool({ flows: [good, bad] });
    await pool.run(chunks(10));
    expect(good.sent.map((c) => c.offset).sort((a, b) => a - b)).toEqual([...Array(10)].map((_, i) => i * 4));
  });

  it('throws no_live_flows when all flows die with chunks remaining', async () => {
    const a = fakeFlow(); const b = fakeFlow();
    a.kill(); b.kill();
    await expect(createSendPool({ flows: [a, b] }).run(chunks(5))).rejects.toThrow('no_live_flows');
  });
});
