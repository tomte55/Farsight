# Farsight

Self-hosted, TeamViewer-like remote desktop for Windows: view + control a remote machine over
WebRTC (DTLS-SRTP), with a self-hosted WSS signaling server and a coturn TURN relay. Two Electron
apps — **host** (the controlled machine) and **controller** (where you drive from). v1 is
**Windows-only** and **attended-access only** (explicit consent required; no unattended mode).

## Layout (npm workspaces)
- `packages/shared` — runtime-agnostic logic, unit-tested in isolation: protocol, input/control
  event validation (security-critical), password, turn, host-id, credentials, signaling-url.
- `packages/signaling-server` — Node `ws` WSS signaling (registry, password auth, rate-limit,
  per-IP DoS limits, structured JSON logging). The **only** internet-facing runtime.
- `packages/host` / `packages/controller` — Electron apps: `src/main.js`, `src/preload.cjs`,
  `src/renderer/` (sandboxed).

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
- **electron-builder must be `^24.13.3`, NOT 25.x** — v25 pulls a broken `app-builder-bin@5-alpha`
  (`spawn app-builder.exe ENOENT`). Installer builds only succeed in CI (Windows runner); local
  builds fail on a winCodeSign symlink-privilege error — that's local-only, ignore it.
- A packaged app window that opens and shows static text does NOT prove the renderer ran — check
  DevTools console for `ERR_FILE_NOT_FOUND` / module-resolution errors.
- **SP3 file-transfer worker** (`packages/*/src/transfer-worker*`, `shared/transfer-*`): a hidden
  `BrowserWindow{show:false}` owns a dedicated RTCPeerConnection + signaling; main runs the
  orchestrator and forwards frames over IPC. Gotchas that all bit v1.9.0 (DOA) and were fixed by
  v1.9.7 — do not regress: (1) the worker's inline importmap needs a **sha256 CSP hash** (its CSP is
  stricter — `script-src 'self'`, no `'unsafe-inline'`), guarded by `transfer-worker-importmap.test.js`;
  (2) `webContents.send()` to the worker is **queued until `did-finish-load`** (Electron drops sends to
  a not-yet-loaded renderer); (3) the worker uses a **dedicated one-shot signaling client**, NOT the
  app's auto-registering main one; (4) hidden workers set `backgroundThrottling:false`; (5) completion
  is a **two-sided delivery ACK** (receiver `complete{ok}` after every file is hash-verified; sender
  waits before closing); (6) **byte-routing is by manifest-order cursor**, never by `FILE_BEGIN` timing
  (ctrl/bulk are separate channels); (7) **no single `ft-ctrl` frame may exceed the ~256KB WebRTC
  data-channel `send()` limit** — a frame over it throws and KILLS the channel before delivery (v1.11.2:
  a 2974-file folder's one-shot OFFER was 346KB → `dc-error` + stuck at 0). Any per-file-scaling frame
  must chunk or filter: the OFFER chunks (`offer_begin`→`offer_entries*`→`offer_end`, ≤48KB batches), the
  accept sends only non-zero resume offsets, and **Phase-5 remote-FS directory listings must paginate**.
  **Test transfers with a real 2-machine / MULTI-chunk / MANY-file E2E** — localhost + one-chunk +
  few-file transfers hide teardown-races, routing bugs, AND the frame-size limit. Worker/main emit
  diagnostics to the app log (`[ft-worker]` heartbeat with ctrl/bulk counters + `[transfer]` lifecycle);
  the `[ft-worker]` counters (`ctrlOut`/`ctrlIn`, `dc-error`) are what pinpoint these from field logs.
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
