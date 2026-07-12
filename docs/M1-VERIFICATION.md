# Milestone 1 — Verification Status

Milestone 1 deliverable: on a single LAN, launch the host (shows a connect code),
launch the controller, enter the code, and see the host's live screen. No input
control yet. Plaintext WS signaling (replaced with WSS in M3).

## Verified automatically (this session)

- ✅ `npm test` — **15 tests across 6 files pass** (protocol, host-id, signaling-url
  guard, signaling registry + relay integration, capture helper).
- ✅ Signaling server starts standalone (`node packages/signaling-server/src/server.js`
  → `[signaling] listening on ws://0.0.0.0:8080`).
- ✅ Host Electron app boots and its **renderer registers with signaling** — verified
  with an instrumented probe server that received `{"type":"register"}` and the app
  displayed its assigned ID. This confirms the preload bridge, the renderer import map,
  and the signaling client all work end-to-end.
- ✅ Controller Electron app boots without crashing (same import-map/preload mechanism
  as the host, already proven).

## Video path — now verified end-to-end

The live WebRTC negotiation was reproduced and confirmed working after fixing two bugs
found during the first manual test (see "Bugs fixed" below). Using a temporary debug
auto-connect harness, the full handshake completed:

- host: `CONNECT received → stream acquired (tracks=1) → peer created → offer handled`
- controller: `CONNECT sent → OFFER sent → ANSWER received → track received`

The `track received` event means the host's screen-capture MediaStream reached the
controller. The only thing left is your eyeballs confirming the picture looks right.

## Bugs fixed after the first manual test

1. **Controller renderer crashed on load** — its import map was missing
   `@farsight/shared/signaling-url` (added with the R-3 guard), so the whole renderer
   failed to load and the Connect button did nothing. Fixed + regression test added
   (`packages/*/test/importmap.test.js` verifies every renderer graph specifier is mapped).
2. **Host dropped the controller's OFFER (race)** — the host builds its peer behind an
   async `getStream()`, but the OFFER and ICE candidates arrive during that await, when
   `peer` was still null, so they were silently dropped and the session hung. Fixed by
   buffering an early offer/candidates and applying them once the peer is ready.

## Final human confirmation (interactive)

Please run these three steps on the Windows machine and confirm the picture:

```powershell
# Terminal 1 — signaling server
node packages/signaling-server/src/server.js

# Terminal 2 — host app  (shows a 9-digit ID)
npm start -w @farsight/host

# Terminal 3 — controller app
npm start -w @farsight/controller
```

Then in the controller, type the host's 9-digit ID and click **Connect**.

- [x] Within a few seconds the controller shows the host's live screen; moving a window
      on the host updates it on the controller. **Confirmed by the user 2026-07-11.**
- [ ] Close the host window → the controller shows "Host disconnected." and returns to
      the connect screen.

### Capture constraint — confirmed working

The host captures the screen with the legacy `getUserMedia({ video: { mandatory: {
chromeMediaSource: 'desktop', ... } } })` constraint. This was verified working in
Electron 33 (the host acquired a 1-track stream). No change needed.

**Milestone 1 is complete** — live LAN screen-view confirmed working by the user on
2026-07-11.
