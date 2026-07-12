# Milestone 2 — Verification Status

Milestone 2 deliverable: the controller's mouse and keyboard drive the host; the host
requires an explicit **Allow** click before control begins, shows an always-visible
session banner with one-click disconnect, and a **panic hotkey** instantly ends any
session.

## Verified automatically (this session)

- ✅ `npm test` — **38 tests across 13 files pass**, including:
  - `input-events` — security-critical whitelist/bounds validation (8 tests)
  - `input-injector` — validates + maps fractional→pixel coords, rejects malformed (3)
  - `input-capture` — DOM→input-event mapping (4)
  - `session` — consent state machine idle→pending→active, deny, end (4)
  - `panic` — accelerator registration + callback wiring (2)
  - the import-map guards now also confirm `input-events` is mapped in the controller
- ✅ **nut.js loads *and executes* in the Electron main process** — a zero-movement probe
  read the real cursor position and set it back (`NUT-PROBE OK`). The native N-API binary
  is ABI-compatible with Electron 33, so no `electron-rebuild` is needed.
- ✅ Host app boots with the consent UI and panic wiring and registers with signaling;
  controller boots. No load errors.

## Architecture notes (deviations from the plan, all deliberate)

- **Input injection runs in the MAIN process, not the renderer.** nut.js is a native Node
  addon and cannot load in the sandboxed renderer (`sandbox: true`, from R-7). The host
  renderer receives input over the data channel and forwards each event to main over IPC
  (`injectInput`); the injector **validates every event** (`validateInputEvent`) in the
  trusted main process before it reaches nut.js. Security gate intact — arguably stronger,
  since validation is out of the renderer.
- **R-7 size guard** folded into the host data-channel handler: payloads over 8 KiB are
  dropped before `JSON.parse`.
- Preload additions went into `preload.cjs` (CommonJS, from R-7), not `preload.js`.

## Requires a human (interactive — moves your real mouse/keyboard)

These could not be automated without jerking your cursor around. Run the three terminals
(signaling / host / controller) as in `docs/M1-VERIFICATION.md`, then:

**Consent gate**
- [ ] Click Connect on the controller → the **host** shows an "Allow control?" prompt and
      **nothing streams yet** (controller still says "Connecting…").
- [ ] Click **Deny** → nothing happens on the controller; host returns to waiting.
- [ ] Reconnect, click **Allow** → video appears on the controller and a **red banner**
      appears on the host.

**Remote control**
- [ ] Move the mouse over the controller's video → the host's cursor follows.
- [ ] Click and type → the host receives the clicks/keystrokes.

**Session end / panic**
- [ ] Click **Disconnect** in the host banner → control stops, banner disappears.
- [ ] During an active session, press **Ctrl+Alt+F12** on the host → the session ends
      immediately (status shows "Session ended by panic key.").

If anything doesn't behave as described, tell me what you saw and I'll debug it.
