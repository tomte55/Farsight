# Milestone 2B — Verification Status

Milestone 2B deliverable: the controller can **list and switch** the host's monitors;
input maps correctly on **secondary / scaled (high-DPI)** displays; control messages ride a
**reliable, ordered** data channel; and ending a session **fully releases screen capture**.

## Verified automatically (this session)

- ✅ `npm test` — **49 tests across 14 files pass**, including the new M2B work:
  - `control-events` — reliable control-channel schema: list/select/monitors/session_end,
    bounds + whitelist, oversized-list and bad-index rejection (5 tests)
  - `input-injector` — now **display-aware**: maps fractional coords into a display's DIP
    bounds, offsets by a secondary monitor's `bounds.x`, applies `dipToScreen` DPI
    conversion, and `setDisplay` switches the target region (6 tests)
  - `capture` — `listDisplays` / `displaySourceId` / `monitorsForControl` enumerate
    monitors and match capture sources (6 tests)
  - both import-map guards now confirm `@farsight/shared/control-events` is mapped in the
    host **and** controller renderers

## Architecture notes (deviations from the plan, all deliberate)

- **The injector stays in the MAIN process** (continuing the R-7 posture from M2). The
  plan's Task 2B.4 Step 4 sketched building the injector in the renderer, but nut.js can't
  load in the sandboxed renderer. Instead: the renderer forwards raw input over IPC, and
  the monitor selection is pushed to main via a new `select-injector-display` IPC so main's
  display-aware injector (`display` bounds + `screen.dipToScreenPoint`) maps into the
  correct monitor. Validation still happens in main before nut.js.
- **DPI mapping uses `screen.dipToScreenPoint`** (physical pixels) rather than a local
  scaleFactor multiply — correct for mixed-DPI multi-monitor setups.
- **Reliable control channel** (`ordered: true`) is separate from the existing unreliable/
  unordered `input` channel; the 8 KiB R-7 size guard is applied on both channels.
- **Monitor switch uses `RTCRtpSender.replaceTrack`** — no renegotiation; the old stream's
  tracks are stopped so only one capture is live.

## Requires a human (interactive — needs a real display, ideally 2 monitors)

Run the three terminals (signaling / host / controller) as in `docs/M1-VERIFICATION.md`,
grant consent (`Allow`) on the host, then:

**Monitor listing + switching** (needs ≥2 monitors on the host)
- [ ] A dropdown appears (top-left of the controller's video) listing every host monitor,
      with the primary marked `• primary`.
- [ ] Select a secondary monitor → the streamed view switches to that monitor.
- [ ] Move/click on the controller's video → input lands on the **selected** monitor at the
      right spot (not the primary).

**High-DPI accuracy**
- [ ] On a monitor set to 150%/200% scaling, the host cursor tracks the controller cursor
      accurately across the whole screen (no drift toward the edges).

**Teardown releases capture**
- [ ] End the session (host **Disconnect**, or **Ctrl+Alt+F12** panic) → the OS
      screen-capture indicator disappears (capture tracks stopped), not just the video.

**Single-monitor fallback** (if only one monitor is available)
- [ ] The dropdown stays hidden (only one display); streaming, input, and teardown all work
      on the single display.

If anything doesn't behave as described, tell me what you saw and I'll debug it.
