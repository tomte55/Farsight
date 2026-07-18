// packages/controller/test/multiflow-e2e-headless.test.js
// Plan 3 Task 7: the strongest feasible in-process proof of real multi-flow
// striping, built as far into the REAL stack as this harness allows without
// spawning two full Electron apps + real WebRTC (see the "what this proves /
// what's deferred" note at the bottom for exactly where the line is drawn).
//
// REAL, unmocked, in this test:
//   - packages/signaling-server's createSignalingServer, listening on a real
//     loopback TCP socket (not a fake/stub — the actual `ws` server + protocol
//     parsing + registry + session bookkeeping used in production).
//   - A REGISTER (receiver/host) + flowCount independent CONNECT(kind:'transfer')
//     sockets (sender side, one per flow, real network round-trips) that the
//     server relays into flowCount real TRANSFER_REQUEST messages carrying the
//     real groupId/flowIndex/flowCount fields (Plan 2 Task 6 relay).
//   - flowCount real ATTACH sockets (receiver side) that pair with those
//     sessions and receive real ICE_SERVERS confirmations from the server —
//     proving the full real session-pairing handshake for every flow, not a
//     hand-constructed session.
//   - The REAL createGroupRendezvous (packages/shared) — driven by the ACTUAL
//     relayed TRANSFER_REQUEST fields, not synthetic ones — folding the
//     flowCount independent requests into ONE onGroupReady/consent.
//   - The REAL assembleSendFlows / assembleReceiveGroup (controller's
//     transfer-channel-assembly.js) — the exact same assembly logic main.js's
//     openChannel uses, unmodified, driving both real per-flow sockets above.
//   - The REAL createTransferService (packages/shared) end to end on both
//     sides — multi-flow branch selection, jobs-store, resume watcher wiring
//     all present (not bypassed).
//
// SIMULATED (the honest gap — see the bottom note): the actual ft-ctrl/ft-bulk
// BYTE TRANSPORT. Real WebRTC data channels only exist inside a Chromium
// renderer (transfer-worker.js's hidden BrowserWindow), which this plain-Node
// vitest process cannot host. Each flow's ctrl/bulk plane is an in-memory
// duplex instead of an RTCPeerConnection data channel. Everything upstream of
// that (signaling, grouping, service orchestration, disk I/O) is real; only
// the wire itself is faked. The maintainer-run "Real 2-machine validation
// checklist" (bottom of docs/private/superpowers/plans/
// 2026-07-18-parallel-transfer-plan3-integration.md) is what proves the real
// WebRTC wire under real network conditions.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { MSG } from '@farsight/shared/protocol';
import { createTransferService } from '@farsight/shared/transfer-service';
import { createJobsStore } from '@farsight/shared/jobs-store';
import { newJobId } from '@farsight/shared/transfer-queue';
import { createGroupRendezvous } from '@farsight/shared/transfer-group-rendezvous';
import { createSignalingServer } from '../../signaling-server/src/server.js';
import { assembleSendFlows, assembleReceiveGroup } from '../src/transfer-channel-assembly.js';

const HOST_PW = 'e2e-multiflow-pw';
const FLOW_COUNT = 4;

let srv;
let port;

beforeAll(async () => {
  // Port 0: OS-assigned free loopback port, so this test can't collide with
  // any other signaling-server test/port regardless of parallel test workers.
  srv = createSignalingServer({
    port: 0,
    config: { maxAttempts: 50, windowMs: 60000, turnSecret: '', turnTtlSeconds: 1, turnUri: '', connectBurst: 50, msgBurst: 200, msgPerSec: 200, sessionTimeoutMs: 15000 },
  });
  await new Promise((resolve) => srv.wss.once('listening', resolve));
  port = srv.wss.address().port;
});
afterAll(async () => { if (srv) await srv.close(); });

const dirs = [];
async function tmp() { const d = await mkdtemp(join(tmpdir(), 'mf-e2e-')); dirs.push(d); return d; }
afterAll(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

function wsOpen() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => { ws.once('open', () => resolve(ws)); ws.once('error', reject); });
}
function onMsg(ws, cb) { ws.on('message', (raw) => cb(JSON.parse(raw.toString()))); }

// A one-directional lane that BUFFERS a send until a listener registers, then
// flushes in order. A real WebRTC data channel (and transfer-worker.js's own
// pendingCtrlOut/pendingCtrlIn queues) already gives this guarantee — nothing
// is ever silently dropped just because the other end hasn't wired its
// handler up yet. Bare unbuffered callback-swap fixtures (fine when a test
// manually sequences "start receive, tick, THEN start send") don't hold here:
// this E2E's receive only starts once the real network round-trip
// (CONNECT->TRANSFER_REQUEST->group-ready->ATTACH) completes, which race
// against the sender's very first OFFER frame — exactly the class of bug this
// buffering exists to not reintroduce.
function makeLane() {
  let cb = null;
  const queue = [];
  return {
    send: (v) => { if (cb) cb(v); else queue.push(v); },
    on: (fn) => { cb = fn; while (queue.length) cb(queue.shift()); },
  };
}

// In-memory ctrl/bulk data plane standing in for N real WebRTC data channels
// (see the file header note). `flowCount` independent bulk lanes, one shared
// ctrl lane-pair (flow 0's, matching production — only worker 0's ctrl
// channel is ever used). Each sender flow's sendBulk is instrumented so the
// test can assert real per-flow byte distribution (the striping proof).
function makeDataPlane(flowCount) {
  const ctrlToReceiver = makeLane(); // sender -> receiver ctrl frames (OFFER, range_report, ...)
  const ctrlToSender = makeLane();   // receiver -> sender ctrl frames (accept, range_report, ...)
  const senderCtrl = { sendCtrl: (s) => ctrlToReceiver.send(s), onCtrl: (cb) => ctrlToSender.on(cb) };
  const receiverCtrl = { sendCtrl: (s) => ctrlToSender.send(s), onCtrl: (cb) => ctrlToReceiver.on(cb) };

  const bulkOutFrames = new Array(flowCount).fill(0);
  const bulkOutBytes = new Array(flowCount).fill(0);
  const bulkLanes = Array.from({ length: flowCount }, () => makeLane());
  const senderFlows = Array.from({ length: flowCount }, (_, i) => ({
    sendBulk: (buf) => {
      bulkOutFrames[i] += 1;
      bulkOutBytes[i] += buf.byteLength;
      // Mirrors the real [ft-worker] heartbeat log line (transfer-worker/worker.js
      // logStatus), so this test's console output is directly comparable to a
      // field log — the maintainer's real diagnostic-reading workflow.
      console.log(`[ft-worker] ${JSON.stringify({ flowIndex: i, bulkOut: bulkOutFrames[i] })}`);
      bulkLanes[i].send(buf);
      // createSendPool (transfer-send-pool.js) dispatches each chunk to
      // whichever flow is CURRENTLY IDLE — real backpressure (credit granted
      // only once the real data channel's bufferedAmount drains) is what
      // makes that spread work across flows instead of always landing on
      // flow 0 the instant it frees up. A zero-latency Promise.resolve() here
      // would defeat that: flow 0 would always be idle again before the pool
      // even looks at flow 1, and every chunk would pile onto flow 0 — the
      // exact "all bytes on one flow" failure mode this test exists to catch,
      // except self-inflicted by the fixture instead of a real regression.
      // This small delay is what makes the pool's real dispatch logic
      // actually need >1 flow, the same way real network latency does.
      return new Promise((resolve) => setTimeout(resolve, 4));
    },
  }));
  const receiverFlows = Array.from({ length: flowCount }, (_, i) => ({ onBulk: (cb) => bulkLanes[i].on(cb) }));
  return { senderCtrl, receiverCtrl, senderFlows, receiverFlows, bulkOutFrames, bulkOutBytes };
}

// SENDER-side fake transfer-worker: real signaling (CONNECT over a real WS
// socket to the real signaling server) + the in-memory data plane above,
// matching createTransferWorker()'s {channel, onSessionState, startRendezvous,
// close} shape exactly so the REAL assembleSendFlows (unmodified production
// code) can drive it.
function makeSenderWorker({ flowIndex, dataPlane }) {
  let ws = null;
  let stateCb = null;
  const channel = {
    sendCtrl: (s) => dataPlane.senderCtrl.sendCtrl(s),
    onCtrl: (cb) => dataPlane.senderCtrl.onCtrl(cb),
    sendBulk: (buf) => dataPlane.senderFlows[flowIndex].sendBulk(buf),
  };
  return {
    channel,
    onSessionState(cb) { stateCb = cb; },
    async startRendezvous(params) {
      ws = await wsOpen();
      onMsg(ws, (m) => {
        if (m.type === MSG.ICE_SERVERS) { if (stateCb) stateCb('connected'); }
        else if (m.type === MSG.ERROR) { if (stateCb) stateCb(`error:${m.reason}`); }
      });
      ws.send(JSON.stringify({
        type: MSG.CONNECT, kind: 'transfer',
        targetId: params.targetId, password: params.password,
        groupId: params.groupId, flowIndex: params.flowIndex, flowCount: params.flowCount,
      }));
    },
    close: async () => { try { ws && ws.close(); } catch { /* ignore */ } },
  };
}

// RECEIVER-side fake attach handle: a real ATTACH over a real WS socket to
// the real signaling server (proves the session-pairing handshake for real),
// wired to the shared in-memory data plane for the actual bytes.
function makeReceiverFlowHandle({ sessionId, flowIndex, groupId, dataPlane }) {
  const attachedDeferred = {};
  attachedDeferred.promise = new Promise((res) => { attachedDeferred.resolve = res; });
  const wsPromise = wsOpen().then((ws) => {
    onMsg(ws, (m) => { if (m.type === MSG.ICE_SERVERS) attachedDeferred.resolve(true); });
    ws.send(JSON.stringify({ type: MSG.ATTACH, sessionId, groupId, flowIndex }));
    return ws;
  });
  return {
    channel: {
      onBulk: (cb) => dataPlane.receiverFlows[flowIndex].onBulk(cb),
      onCtrl: (cb) => dataPlane.receiverCtrl.onCtrl(cb),
      sendCtrl: (s) => dataPlane.receiverCtrl.sendCtrl(s),
    },
    close: async () => { try { const ws = await wsPromise; ws.close(); } catch { /* ignore */ } },
    peerAuth: Promise.resolve({ tier: null }),
    flowIndex,
    attached: attachedDeferred.promise, // real network confirmation, asserted below
  };
}

async function until(pred, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

// Wait for every flow's REAL session-state to report 'connected' (i.e. its
// ATTACH round-trip actually paired and both ends got ICE_SERVERS) before
// handing the bundle back to createTransferService. Real transfer-worker.js
// data channels don't exist until this real handshake completes either — the
// difference is that in production the accept/consent round-trip ALSO rides
// the same (slower) real channel, so by the time the send pool tries to
// dispatch a chunk the flows have long since connected. Here the ctrl plane
// is an instant in-memory lane (see makeLane), so without this explicit gate
// the pool can race ahead of the real network handshake and see zero live
// flows (a `no_live_flows` failure that has nothing to do with striping).
async function waitAllAlive(flows, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!flows.every((f) => f.isAlive())) {
    if (Date.now() - t0 > timeoutMs) throw new Error('flows never reported connected (real ATTACH handshake did not complete)');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('multi-flow E2E: real loopback signaling + real group-rendezvous + real service, simulated wire', () => {
  it('registers a real host, real-CONNECTs+real-ATTACHes 4 flows, and stripes a real transfer byte-identical across ≥2 flows', async () => {
    // ---- Real signaling: REGISTER the receiver as a host. ----
    const hostWs = await wsOpen();
    const registered = new Promise((resolve) => { hostWs.once('message', (raw) => resolve(JSON.parse(raw.toString()))); });
    hostWs.send(JSON.stringify({ type: MSG.REGISTER, password: HOST_PW }));
    const reg = await registered;
    const hostId = reg.id;
    expect(typeof hostId).toBe('string');
    expect(hostId.length).toBeGreaterThan(0);

    // ---- Fixtures: files (one multi-chunk, two small) + jobs-stores + dirs. ----
    const CHUNK = 131072;
    const srcDir = await tmp();
    const dstDir = await tmp();
    const sendStore = createJobsStore({ dir: await tmp() });
    const recvStore = createJobsStore({ dir: await tmp() });

    const big = new Uint8Array(CHUNK * 3 + 211).map((_, i) => (i * 41 + 7) & 0xff);
    const s1 = new Uint8Array(2000).map((_, i) => (i * 13) & 0xff);
    const s2 = new Uint8Array(37).fill(9);
    await writeFile(join(srcDir, 'big.bin'), big);
    await writeFile(join(srcDir, 's1.bin'), s1);
    await writeFile(join(srcDir, 's2.bin'), s2);
    const entries = [
      { fileId: 0, path: 'big.bin', size: big.length, mtime: 1 },
      { fileId: 1, path: 's1.bin', size: s1.length, mtime: 1 },
      { fileId: 2, path: 's2.bin', size: s2.length, mtime: 1 },
    ];
    const manifest = { entries, totalBytes: big.length + s1.length + s2.length, totalFiles: 3 };
    const sources = new Map([
      [0, join(srcDir, 'big.bin')],
      [1, join(srcDir, 's1.bin')],
      [2, join(srcDir, 's2.bin')],
    ]);

    const dataPlane = makeDataPlane(FLOW_COUNT);

    // ---- RECEIVER side: real group-rendezvous, fed by REAL relayed
    // TRANSFER_REQUESTs (not hand-constructed), assembling via the REAL
    // assembleReceiveGroup and driving the REAL createTransferService. ----
    const receiverFlowHandles = [];
    const pendingGroupReceives = new Map();
    let receivePromise = null;
    const groupRendezvous = createGroupRendezvous({
      openFlow: ({ sessionId, flowIndex, groupId }) => {
        const h = makeReceiverFlowHandle({ sessionId, flowIndex, groupId, dataPlane });
        receiverFlowHandles.push(h);
        return h;
      },
      onGroupReady: ({ groupId, flowCount, flows }) => {
        const bundle = flowCount > 1 ? assembleReceiveGroup(flows) : flows[0];
        pendingGroupReceives.set(groupId, bundle);
        receivePromise = receiverSvc.startReceive({ rendezvous: { sessionId: groupId, linked: false } })
          .finally(() => groupRendezvous.cancel(groupId));
      },
    });

    const receiverSvc = createTransferService({
      store: recvStore, transferDir: dstDir, consent: async () => true,
      openChannel: async ({ sessionId }) => {
        const bundle = pendingGroupReceives.get(sessionId);
        if (!bundle) throw new Error(`no pre-opened group bundle for session ${sessionId}`);
        pendingGroupReceives.delete(sessionId);
        return bundle;
      },
      receiveCloseGraceMs: 0,
    });

    // Real network relay: every TRANSFER_REQUEST the host socket receives
    // (one per flow, carrying the REAL groupId/flowIndex/flowCount the server
    // relayed) is fed into the real coordinator — exactly main.js's wiring.
    onMsg(hostWs, (m) => {
      if (m.type === MSG.TRANSFER_REQUEST) {
        groupRendezvous.offer({ sessionId: m.sessionId, groupId: m.groupId, flowIndex: m.flowIndex, flowCount: m.flowCount, linked: !!m.linked });
      }
    });

    // ---- SENDER side: real createTransferService, whose multi-flow branch
    // opens FLOW_COUNT real CONNECT sockets via the REAL assembleSendFlows. ----
    const senderSvc = createTransferService({
      store: sendStore, transferDir: srcDir, consent: async () => true,
      openChannel: async ({ role, target, flowCount }) => {
        expect(role).toBe('initiate');
        expect(flowCount).toBe(FLOW_COUNT);
        const groupId = newJobId();
        const bundle = assembleSendFlows({
          flowCount,
          createWorker: (flowIndex) => makeSenderWorker({ dataPlane, flowIndex }),
          makeParams: (flowIndex) => ({ targetId: target.id, password: target.password, groupId, flowIndex, flowCount }),
        });
        await waitAllAlive(bundle.flows);
        return bundle;
      },
    });

    const jobId = newJobId();
    const sendResult = await senderSvc.startSend({
      jobId, manifest, sources,
      target: { id: hostId, password: HOST_PW, flowCount: FLOW_COUNT },
    });

    // The receive is kicked off asynchronously once the group-rendezvous fires
    // (after all 4 real CONNECT/TRANSFER_REQUEST/ATTACH round-trips settle) —
    // wait for it to exist, then for it to finish.
    await until(() => receivePromise !== null);
    const recvResult = await receivePromise;

    // ---- Assertion 1: the real per-flow ATTACH handshake actually paired
    // (real ICE_SERVERS confirmation from the real signaling server), for
    // every flow — not just that the group fired. ----
    expect(receiverFlowHandles.length).toBe(FLOW_COUNT);
    await Promise.all(receiverFlowHandles.map((h) => h.attached));

    // ---- Assertion 2: byte-identical on real disk. ----
    expect(sendResult.ok).toBe(true);
    expect(recvResult.ok).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 'big.bin'))).equals(Buffer.from(big))).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 's1.bin'))).equals(Buffer.from(s1))).toBe(true);
    expect(Buffer.from(await readFile(join(dstDir, 's2.bin'))).equals(Buffer.from(s2))).toBe(true);

    // ---- Assertion 3 (THE striping proof): at least 2 of the FLOW_COUNT
    // flows each carried a non-trivial share of the bulk bytes. A test that
    // passes with all bytes parked on one flow is worthless (brief's own
    // words) — this fails if the sender's pool ever regresses to
    // single-flow-only dispatch. See the report for the mutation check that
    // forced all bytes onto flow 0 and confirmed this line fails.
    const totalBulkBytes = dataPlane.bulkOutBytes.reduce((a, b) => a + b, 0);
    const flowsWithNonTrivialShare = dataPlane.bulkOutBytes.filter((b) => b > totalBulkBytes * 0.05).length;
    console.log('[ft-worker-summary]', JSON.stringify({ bulkOutBytes: dataPlane.bulkOutBytes, totalBulkBytes }));
    expect(totalBulkBytes).toBeGreaterThan(0);
    expect(flowsWithNonTrivialShare).toBeGreaterThanOrEqual(2);

    const recvJobs = await recvStore.list();
    const recvRec = recvJobs.find((j) => j.jobId === jobId);
    expect(recvRec).toBeTruthy();
    expect(recvRec.jobState).toBe('done');

    hostWs.close();
    await Promise.all(receiverFlowHandles.map((h) => h.close()));
  }, 20000);
});
