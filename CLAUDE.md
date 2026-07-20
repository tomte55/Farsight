# Farsight

Self-hosted, TeamViewer-like remote desktop for Windows: view + control a remote machine over
WebRTC (DTLS-SRTP), with a self-hosted WSS signaling server and a coturn TURN relay. Windows-only.

> **v2.0 — UNIFIED APP (2026-07-17).** The two apps were merged into **one**: `packages/controller`
> is now the single **Farsight** app (appId `org.farsight.app`, productName `Farsight`, update
> channel `latest`) that **controls, hosts, and transfers**. It's a **tray app** (close hides to
> tray; Quit from the tray) so it stays reachable to be controlled. Being controlled is gated by a
> Home toggle **"Allow this computer to be controlled"** (default ON, receiver-side, fails closed —
> SECURITY.md R-9). The old **`packages/host`** app is **RETIRED** — kept in the repo as history/port
> reference but no longer built or released. v2 is a **clean-break** identity, so v1 installs do NOT
> auto-update into it (one-time manual reinstall). Much of `packages/host`'s renderer/main logic was
> ported verbatim into `packages/controller` (session machine, capture, nut.js injection, host peer,
> auto-registering signaling client, tray/lifecycle). The package dir is still named `controller` (an
> internal, user-invisible name); renaming it to `packages/app` is a deferred cleanup. Much of the
> per-app guidance below that says "host does X / controller does Y" now describes **one app doing
> both** — read it as capability, not separate binaries.

## Ways of working (maintainer ⇄ assistant) — read `docs/WORKING-AGREEMENT.md`
Adopted 2026-07-19 after the transfer reliability deep-dive, to stop piling features on an unstable
base. **Roles:** the maintainer owns the WHAT/WHY (vision, priorities, go/no-go at gates); the
assistant acts as **engineering manager** — owns the HOW/WHEN (sequencing, method), brings decisions
with a recommendation, and says "not yet — here's where it goes" when work is premature, *especially*
under time pressure. **Non-negotiables:** (R1) phases with a written spec + a "done" gate, no
half-finished layers; (R2) stability before features — nothing new on a base that isn't one-path,
loud-on-failure, and tested; (R3) brainstorm→spec→plan→build; (R4) tests pin BEHAVIOR not
source-string greps, transfer-critical paths proven on a REAL wire, mutation-check every guard;
(R5) fail loud — never swallow errors into a hang or a silent vanish; (R6) evidence before "done";
(R7) delete dead code (tested dead code is worse), one implementation per capability; (R8) one
source of truth for done/progress/resume; (R9) honest status, deferrals written down. The full text
+ current transfer roadmap live in `docs/WORKING-AGREEMENT.md`.

## Layout (npm workspaces)
- `packages/shared` — runtime-agnostic logic, unit-tested in isolation: protocol, input/control
  event validation (security-critical), password, turn, host-id, credentials, signaling-url.
- `packages/signaling-server` — Node `ws` WSS signaling (registry, password auth, rate-limit,
  per-IP DoS limits, structured JSON logging). The **only** internet-facing runtime.
- `packages/controller` — the unified **Farsight** Electron app (`src/main.js`, `src/preload.cjs`,
  `src/renderer/` shell + `src/session-window/` for a controlling session). `packages/host` is the
  **retired** v1 host app (frozen; not built).

## Commands
- **Test:** `npx vitest run` (or `npm test`). This project is built strict-TDD, one commit per task.
- **Run locally (LAN):** `node packages/signaling-server/src/server.js`, then
  `npm start -w @farsight/host` and `npm start -w @farsight/controller`. Apps have no baked-in
  signaling URL — configure one on first run (persisted per-user), or set
  `FARSIGHT_SIGNALING_URL=ws://127.0.0.1:8080` (env overrides the stored value) to use local
  signaling.
- **Release:** push a tag `vX.Y.Z` → GitHub Actions (`.github/workflows/release.yml`) builds the
  Windows installers and publishes a GitHub Release with an auto-generated changelog. Do NOT build
  installers locally (see gotchas).

## Non-obvious constraints — read before touching these areas
- **Sandboxed renderers** (`sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`): bare
  `@farsight/shared/*` imports don't resolve in Chromium. Each renderer `index.html` has a
  `<script type="importmap">` mapping them to `../shared/*.js`, and `scripts/vendor-shared.mjs`
  copies `packages/shared/src` → `packages/<app>/src/shared/` (gitignored) via `prestart`/`predist`.
  This vendored path resolves identically in dev AND in the packaged asar — the old
  `../../../shared/src/` path only worked in dev and broke packaging. Guarded by
  `packages/*/test/importmap.test.js`.
- **Preloads are CommonJS** (`preload.cjs`) — sandboxed preloads can't be ESM.
- **Native addons run in MAIN, never the renderer.** nut.js (input injection) and argon2 load in the
  main process; the renderer forwards validated events over IPC. Keep shared modules imported by
  renderers runtime-agnostic (e.g. host-id uses Web Crypto).
- **Every BrowserWindow needs `backgroundThrottling:false`** (both apps' MAIN windows + the hidden
  transfer workers). The renderers own signaling, the peer connection and input — and Chromium drops
  a minimized *or merely COVERED* window's renderer to Windows **Idle process priority**. An active
  host saturates its own CPU (capture+encode), so the renderer starves: measured **4084ms avg input
  latency / 10.9s max / 26% of input events LOST**, vs 4ms/none with the flag. Video survives (media
  runs off the renderer main thread) — so the symptom is "stream fine, input dead", not an obvious
  hang. It's a PRIORITY problem, not timer throttling (timer throttling is real — 4/s→1.1/s — but
  datachannel delivery is unaffected by it). Guarded by `packages/*/test/window-throttling.test.js`.
- **A hidden transfer-worker BrowserWindow keeps the app alive.** `window-all-closed` never fires
  while a transfer runs, so the CONTROLLER's main window must explicitly `app.quit()` on `closed` —
  otherwise closing it leaves an invisible process still moving bytes, holding the single-instance
  lock so a relaunch silently does nothing. (The HOST is the opposite by design: it hides to tray.)
- **Never gate a remote-management control on "no session is active."** A remote session is the ONLY
  way to touch a remote host, so `!sessionActive` gating makes a remote machine un-manageable by
  construction — it bit the console Update button AND the tray's "Restart to update". An explicit
  human/owner request overrides the guard; only automatic/background work defers. Keep `overrideSession`
  and `silent` as SEPARATE concerns — conflating them into one `force` flag caused three incidents.
- **`updater.quitAndInstall(true)` is a TRAP** — electron-updater only substitutes
  `autoRunAppAfterInstall` when `isSilent` is *false*, so the one-arg "silent" call leaves
  `isForceRunAfter:false` and the app **installs and never relaunches** (it took a host offline three
  times). The only correct silent call is `quitAndInstall(true, true)`. Both production call sites are
  pinned by tests asserting the ARGUMENTS — every updater test used to assert call COUNT only, which
  is exactly how this shipped.
- **A send must be persisted BEFORE its first byte.** `runSend` saves `jobState:'active'` up front;
  at launch a `dir:'send'` record still saying `'active'` is impossible (its process is gone) and is
  swept — fleet/contact→`'interrupted'` (resumable), adhoc→`'error'`. Without the up-front save an
  in-flight send lives only in an in-memory Map and dies with the process: nothing to list, nothing to
  resume. (v1.12.0's "across-restart resume" never worked for this reason; first verified live in
  v1.14.4.) Relatedly, **jobs-store writes are SERIALIZED per jobId** — concurrent saves corrupted
  records (74/120), and unique tmp names alone don't fix it (Windows throws EPERM on concurrent
  renames onto one target).
- **electron-builder must be `^24.13.3`, NOT 25.x** — v25 pulls a broken `app-builder-bin@5-alpha`
  (`spawn app-builder.exe ENOENT`). Installer builds only succeed in CI (Windows runner); local
  builds fail on a winCodeSign symlink-privilege error — that's local-only, ignore it.
- A packaged app window that opens and shows static text does NOT prove the renderer ran — check
  DevTools console for `ERR_FILE_NOT_FOUND` / module-resolution errors. **But "no console errors" is
  NOT proof either:** Electron's `console-message` event does **not** fire on an ES-module
  import-resolution failure (confirmed with a deliberate broken import — the module silently never
  executed, zero events). Require POSITIVE proof: read a value the renderer only sets *after* its
  imports resolved and it ran to completion. A `show:false` BrowserWindow + `--remote-debugging-port`
  + CDP `Runtime.evaluate` drives the real packaged renderer and is the fastest way to measure this.
- **Mutation-test any test that guards an invariant.** Repeatedly on this project a test passed for
  the WRONG reason — a different condition forced the expected outcome — including tests written
  specifically to pin a guard. Change the guard, watch the test fail, change it back. A green suite is
  not evidence a guard is pinned; count-only assertions (`toHaveBeenCalledTimes`) are the classic tell.
- **SP3 file-transfer worker** (`packages/*/src/transfer-worker*`, `shared/transfer-*`): a hidden
  `BrowserWindow{show:false}` owns a dedicated RTCPeerConnection (N of them, at N=1 by default in a
  degenerate one-flow group) + signaling; main runs `transfer-sender.js`/`transfer-receiver.js` (the
  ONE coverage-model sender/receiver — Phase 2, 2026-07-20 — the old single-flow driver + dead
  `transfer-engine.js` are deleted) and forwards frames over IPC. Gotchas that all bit v1.9.0 (DOA)
  and were fixed by v1.9.7 — do not regress: (1) the worker's inline importmap needs a **sha256 CSP
  hash** (its CSP is stricter — `script-src 'self'`, no `'unsafe-inline'`), guarded by
  `transfer-worker-importmap.test.js`; (2) `webContents.send()` to the worker is **queued until
  `did-finish-load`** (Electron drops sends to a not-yet-loaded renderer); (3) the worker uses a
  **dedicated one-shot signaling client**, NOT the app's auto-registering main one; (4) hidden
  workers set `backgroundThrottling:false`; (5) completion is a **two-sided delivery ACK** (receiver
  `complete{ok}` after every file is hash-verified; sender waits before closing); (6) **bulk
  byte-routing is POSITIONAL, by self-addressed chunk offset** — every bulk frame carries its own
  `[fileId][offset][length][payload]` (see `transfer-chunk.js` / `transfer-receive-router.js`), so a
  re-delivered chunk is a harmless overwrite at the same offset; this replaced an earlier, since-
  deleted single-flow "manifest-order cursor" scheme, never `FILE_BEGIN` timing (ctrl/bulk are
  separate channels); (7) **no single `ft-ctrl` frame may exceed the ~256KB WebRTC data-channel
  `send()` limit** — a frame over it throws and KILLS the channel before delivery (v1.11.2: a
  2974-file folder's one-shot OFFER was 346KB → `dc-error` + stuck at 0). Any per-file-scaling frame
  must chunk or filter: the OFFER chunks (`offer_begin`→`offer_entries*`→`offer_end`, ≤48KB batches), the
  accept sends only non-zero resume offsets, and **Phase-5 remote-FS directory listings must paginate**.
  **Test transfers with a real 2-machine / MULTI-chunk / MANY-file E2E** — localhost + one-chunk +
  few-file transfers hide teardown-races, routing bugs, AND the frame-size limit. The real-wire CI
  gate (`.github/workflows/ci.yml`) runs the headless two-process harness at both **N=1** (single-flow
  self-test) and **4-flow** (F-B10 multi-flow regression guard) — both exercise the SAME sender/receiver
  code path. Worker/main emit diagnostics to the app log (`[ft-worker]` heartbeat with ctrl/bulk
  counters + `[transfer]` lifecycle); the `[ft-worker]` counters (`ctrlOut`/`ctrlIn`, `dc-error`) are
  what pinpoint these from field logs.
- **Transfer flow-death recovery is SUPERVISOR-OWNED (Phase 3a, 2026-07-20).** A dropped flow is
  bounded by a `disconnectedGraceMs` (4000ms, mutation-checked) grace timer in
  `transfer-flow-supervisor.js` before the supervisor escalates to a re-dial — the worker no longer
  runs an autonomous ICE-restart (deleted, grep-proven zero remaining callers), so there is exactly
  ONE place a dead flow gets recovered, never two racing paths. `transfer-send-pool.js` also has a
  mutation-checked per-chunk `chunkStallMs` (10000ms) backstop so a single stranded dispatched-chunk
  promise can never block completion, and a `rate_limited` slot re-dials on its own wider
  `rateLimitedCooldownMs` (30000ms) instead of the normal per-attempt backoff. This closed F-B11: the
  fault-injection harness's flow-death scenarios (`transfer-fault-e2e.mjs` — `fb1` drops a live
  flow's signaling socket, `fb2` crashes its worker renderer) used to stall to 5/6 files ~⅔ of the
  time; real-wire re-runs (5x each, `SPIKE_NO_RETRY=1`) now deliver byte-identical N/N every time —
  `fb1`@4-flow 5/5, `fb1`@8-flow 5/5, `fb2`@4-flow 5/5 — with the fault still surfaced loudly
  (`conn:error:signaling_*` / `worker-gone:crashed`) rather than swallowed. `fb1`/`fb2` at
  flowCount=4 are a required CI gate alongside the N=1 + 4-flow baseline harness. The gate itself
  ASSERTS byte-identical N/N delivery + a `completed` terminal state (a review-fix hardening,
  2026-07-20 — it used to only log delivery as INFO, so a gate run could pass green on a dropped
  file; re-verified 3/3 each for `fb1`/`fb2` under the stronger check, and bite-confirmed by
  temporarily forcing the check to fail, which flipped the exit code). **Deferred (R9):** F-C5
  (`getStats()` wired, no consumer reads it yet); F-B7 (the control-SESSION signaling reconnect in
  `peer.js` still runs its own ICE-restart — a separate code path from the transfer worker, untouched
  by this phase); flow-count auto-scaling (still a fixed default).
- **Two GATED, outward-facing actions** require explicit user approval per homelab ops rules: the
  signaling deploy (public subdomain) and opening coturn firewall ports.
- **Logging: connection modules run in the RENDERER**, not main — they log via the `log:renderer`
  IPC bridge (`createRendererLogger`), never by importing a file-sink logger directly (that only
  works in main). Verbose connection detail is logged at `debug`; set `FARSIGHT_LOG_LEVEL=debug`
  and reproduce to see it. See "Diagnostics upload" in `docs/SECURITY.md` for the consent-gated
  account upload of the resulting log files.

## Deployment
Farsight is self-hosted: a `ws` signaling server (`packages/signaling-server`, Docker) behind a
TLS reverse proxy (Caddy), plus a coturn TURN relay (`infra/coturn`). See
`docs/SELF-HOSTING.md` for setup. Deployment-specific values (domains, host, paths) live in
`infra/.env`; the maintainer's own environment notes are in the gitignored `CLAUDE.local.md`.

## Reference docs
- Per-milestone verification + deviations: `docs/M*-VERIFICATION.md`
- Security posture + trust assumptions (R-8): `docs/SECURITY.md`
- Self-hosting guide: `docs/SELF-HOSTING.md`
- Internal task-by-task plans, specs, and audits are local-only, under the gitignored
  `docs/private/` (not published; see `CLAUDE.local.md` for pointers).
