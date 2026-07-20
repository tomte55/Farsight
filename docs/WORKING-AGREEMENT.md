# Working Agreement — Farsight (maintainer ⇄ assistant)

Written 2026-07-19, after the transfer reliability deep-dive. Its purpose is to keep us out of the
trap that got us here: features piled on an unstable base under time pressure, reactive patching
that grew scar tissue and duplicate code paths, tests that pass without testing anything, and
failures that hang or vanish instead of surfacing. These are the rules we hold each other to.

## Roles

- **Maintainer** — owns the **WHAT** and the **WHY**: the vision, the priorities, and the
  **go/no-go at every gate**. Decides the forks. Knows what needs to be built.
- **Assistant (Claude)** — acts as **engineering manager**: owns the **HOW** and the **WHEN** —
  sequencing, method, and discipline. Brings **decisions with a recommendation**, not open-ended
  questions. Says **"not yet — here's where it goes"** when work is premature, and records where it
  goes. Holds the line *especially* when there's time pressure. That is the job, not a betrayal of
  it.

## The rules

- **R1 — Phases, not piles.** Work proceeds in written phases. Each phase has a spec and a "done"
  bar (a gate). No next phase starts until the gate is met *and* the maintainer says go. No
  half-finished layers left in the tree.
- **R2 — Stability before features.** No new capability is built on a base that isn't *one path*,
  *loud on failure*, and *tested*. Premature feature work is refused-and-rescheduled, and where it
  belongs on the roadmap is written down.
- **R3 — Brainstorm → spec → plan → build.** No code before a design is agreed and a spec written.
  No implementation without a task-by-task plan. (Superpowers: brainstorming → writing-plans → TDD.)
- **R4 — Real tests, or it isn't tested.** Tests pin **behavior**, never source string-matches.
  Transfer-critical paths are proven on a **real wire** (real `RTCPeerConnection`), not a faked
  one. **Mutation discipline:** change the guard, watch the test fail, *before* trusting it.
- **R5 — Fail loud.** No swallowing errors into silence. Every failure surfaces as an explicit,
  bounded, observable event or record. "It hangs" and "it silently vanishes" are bugs, always.
- **R6 — Evidence before "done."** Never claim complete / fixed / passing without running the
  verification and showing the output. (Superpowers: verification-before-completion.)
- **R7 — Leave it better.** Delete dead code rather than leaving it — dead code that is *tested* is
  worse, because it manufactures false confidence. **One implementation per capability**; never a
  second parallel path for the same job. Keep modules small and single-purpose.
- **R8 — One source of truth for state.** "Done", progress, and resume derive from one
  authoritative place — never re-inferred in several.
- **R9 — Honest status.** Report what passed, what was skipped, and what's deferred — plainly.
  Deferrals are decisions, written down, not silent omissions.

## Cadence

- **Checkpoint at every phase gate:** what's done, the evidence, what's next, and any decision the
  maintainer needs to make.
- The assistant keeps the roadmap, this agreement, and the audit/spec docs as **living documents**.

## Current roadmap — transfer stabilization

1. **Honest & observable** (Phase 1) — *in progress.* Spec:
   `docs/private/superpowers/specs/2026-07-19-transfer-phase1-honest-observable-design.md`
   (plan: `docs/private/superpowers/plans/2026-07-19-transfer-phase1a-honest-state-ci.md`).
2. **One path** — collapse to the coverage model; delete the single-flow stack; unify
   completion/resume/hash/writer. **DONE (2026-07-20).** Evidence: single-flow `createSender`/
   `createReceiver` and the dead `transfer-engine.js` deleted, grep-proven zero live callers; ONE
   sender + ONE receiver, split into `packages/shared/src/transfer-sender.js` +
   `transfer-receiver.js` (+ shared helpers in `transfer-orchestrator-shared.js`); F-D3 (corrupt
   jobs-store record surfaces as a reapable error, not a silent vanish) and the legacy-resume
   clean-break both fixed with mutation-checked tests; F-A4 (`completed_with_errors` wiring) and
   F-C6 (`recoverStaleJobs()` recv sweep) regressions confirmed still green through the collapse;
   real-wire headless two-process harness byte-identical GREEN at both **N=1** (single-flow
   self-test) and **N=8** (F-B10 multi-flow regression guard), both wired as required CI gates in
   `.github/workflows/ci.yml`; full `npx vitest run` suite green (205 files / 1405 tests).
   **Honest deferrals (R9), carried to Phase 3/4:** the default flow count stays N=8 — the
   supervisor is un-hardened above that until Phase 3 does the reliability work; the F-B11 resupply
   gap is still present in the default path, but it's loud (visible stall/error) and resumable, not
   silent; the F-D4 auth-gate buffering trim is deferred; `skipExisting`'s disk-skip optimization is
   now dead code (candidate cleanup for Phase 4, not deleted yet); the F-A2 fix (legacy single-flow
   recv records always restart from zero, never cross-model resume) is an *emergent* safety
   property of the current code shape — a future ".part size == final size → skip resend"
   optimization would reintroduce the exact hazard F-A2 fixed, so it must be re-checked against the
   Task 8 regression test before landing.
3. **Reliable supervisor at 8–16 flows** — speed is a hard requirement (the maintainer's link to
   his dad is slow); make high flow counts genuinely trustworthy.
   - **Phase 3a — flow-death recovery. DONE (2026-07-20).** Closed F-B11: before this phase, the
     fault-injection harness's flow-death scenarios (a live flow's signaling socket dropped, or its
     worker renderer crashed mid-transfer) delivered only 5/6 files ~⅔ of the time and stalled to the
     25s watchdogs the rest. Fix: **one recovery owner** — the supervisor now bounds a flow's
     `'disconnected'` state with a mutation-checked `disconnectedGraceMs` (4000ms) grace timer before
     escalating to a re-dial, and the worker's own autonomous ICE-restart was **deleted** (grep-proven
     zero remaining callers) so there is exactly one place a dead flow gets recovered, not two racing
     each other; the send-pool got a mutation-checked per-chunk `chunkStallMs` (10000ms) backstop so a
     stranded in-flight chunk promise can never block completion; `rate_limited` slots re-dial on a
     wider, separate `rateLimitedCooldownMs` (30000ms), not the normal per-attempt backoff.
     **Evidence — real-wire, `transfer-fault-e2e.mjs`, 5 repeat runs each, `SPIKE_NO_RETRY=1`:**
     `fb1` (F-B1, dropped flow signaling socket) at flowCount=4: **5/5** byte-identical N/N;
     `fb1` at flowCount=8: **5/5** byte-identical N/N; `fb2` (F-B2, crashed worker renderer) at
     flowCount=4: **5/5** byte-identical N/N. All 15/15 runs surfaced the fault loudly (sender log
     `conn:error:signaling_*` for fb1, `worker-gone:crashed` for fb2) AND reached `recv ev=completed`
     — never `interrupted`/`stalled`, never a silent hang. `fb1`/flowCount=4 and `fb2`/flowCount=4 are
     now a **required CI gate** (`.github/workflows/ci.yml`, `real-wire` job); `fb1`/flowCount=8 stays
     a maintainer pre-merge check (redundant scale confirmation, not worth the extra shared-runner
     minutes on every push). Full `npx vitest run` green (205 files / 1416 tests); baseline
     `two-process-harness.mjs` (no fault injection) re-confirmed byte-identical at N=1 and N=8 — happy
     path not regressed.
     **Review fix 1 (2026-07-20):** the harness computed byte-identical N/N delivery but only logged it
     as INFO — the gate itself never asserted it, so a run could go green on a terminal `interrupted`
     with a dropped file (the exact old 5/6 F-B11 bug), a silent-regression gap. Hardened
     `transfer-fault-e2e.mjs` so a run now FAILS unless the receiver's terminal state is `completed`
     AND every file lands byte-identical, alongside the existing surfaced+bounded checks. Re-verified
     3/3 for both `fb1` and `fb2` at flowCount=4 under the stronger assertion, and bite-confirmed by
     temporarily forcing `deliveredAll = false`, which flipped the exit code from 0 to 1 with the
     expected failure message (then reverted).
     **Review fix 2 (2026-07-20):** "byte-identical" from fix 1 was still a lie — `deliveredAll` came
     from `awaitDelivery()`, which only checks FILENAME presence on disk, never bytes or hash, so a
     truncated/corrupted/zero-length file under the correct name still passed green. Wired in the
     already-existing `verifyDelivery()` (sha256 + size compare, the same verifier
     `two-process-harness.mjs` uses for the happy-path CI gate) as the authoritative check, with the
     filename count kept only as a cheap pre-check. Re-verified 3/3 for both `fb1` and `fb2` at
     flowCount=4 under real sha256 verification (no corruption found — the filename-only proxy from fix
     1 was not hiding a real bug), and bite-confirmed by temporarily corrupting a received file's bytes
     before verification, which flipped the exit code from 0 to 1 with a `HASH MISMATCH` failure (then
     reverted).
     **Honest deferrals (R9), carried to Phase 3b+:** F-C5 (`getStats()` wired but no consumer reads
     it — deferred until something needs the numbers); F-B7 (the control-SESSION signaling
     reconnect — `peer.js` still runs its own ICE-restart for the remote-control session, a *separate*
     code path from the transfer worker; not touched by this phase, revisit later); flow-count
     auto-scaling (still a fixed default, not adaptive to link quality).
   - **Phase 3b — receive resilient to consent-window flow churn. DONE (2026-07-20).** Closed F-B5/F-B6:
     a multi-flow RECEIVE is now resilient to flow churn AROUND the human consent window. Two changes,
     both mutation-checked by unit tests (the deterministic proofs): (1) **group-ready is
     anchor-driven** (`transfer-group-rendezvous.js`) — flow 0 is the anchor that MUST fire; a missing
     flow 0 at the 8s `joinWindowMs` arms a bounded `anchorWaitMs` (20000ms) grace, then fires anchorless
     so main aborts clean-loud (`transfer group aborted (no flow 0)`) instead of hanging on a null
     bundle. (2) A per-sessionId **pre-consent BUFFER** (`transfer-service.js`) — a flow offered before
     the receive is `'accepted'` (during a held consent prompt) is BUFFERED, not dropped, drained+attached
     on accept, and closed on teardown; `main.js` `onFlowJoin` delegates to `offerRollingJoin` and logs
     `rolling-join` / `rolling-join buffered` / `rolling-join dropped (receive ended)` distinctly.
     **Evidence — real-wire, `transfer-fault-e2e.mjs`:** `fb5` (F-B5, receive flow 0 dropped mid-transfer)
     at flowCount=4: **3/3** byte-identical N/N, fault surfaced (`conn:error:signaling_dropped` in the
     RECEIVER log), `recv ev=completed`; `fb6` (F-B6, a sender flow dropped INTO an 8s-held consent window,
     so the supervisor's re-dial arrives while the receive is PENDING) at flowCount=4: **3/3**
     byte-identical N/N, each run showing a `rolling-join buffered flow=1` line (the raced flow was HELD,
     not dropped) then `recv ev=completed`. Both also **1/1** at flowCount=8. `fb5`/`fb6` at flowCount=4
     are now a **required CI gate** (`.github/workflows/ci.yml`, `real-wire` job) alongside `fb1`/`fb2`;
     each completes in ~15-20s. Full `npx vitest run` green (205 files / 1420 tests); baseline
     `two-process-harness.mjs` re-confirmed byte-identical at N=1 and N=4, and `fb1`/`fb2` @4 still green —
     the anchor fire-condition did not break normal all-N group firing.
     **Diagnosis note (harness):** the fault registry is PER-PROCESS, so a `side:'receive'` fault must be
     dispatched on the RECEIVER's renderer (receive workers only register there); and the re-dialed flow
     that must be buffered is produced by the SENDER's supervisor re-dial (a `dropFlowSocket` surfaces a
     terminal `error:` → `scheduleRedial`), so `fb6` drops a SENDER flow but must do so only AFTER the
     `consent prompt shown` log — injecting earlier let the ~500ms re-dial rejoin the still-forming
     rendezvous as a normal 4/4 join (no buffer path exercised).
     **Honest deferrals (R9), carried to Phase 3b-2+:** **Phase 3b-2 (auth-inherit) is next** — a
     non-anchor/re-dialed flow still runs the FULL handshake (password/keypair auth) rather than
     inheriting the group's already-verified peer identity; pre-consent PC-count reduction (all N flows
     are dialed + connected before consent, holding N peer connections open during the human decision);
     F-C5 (`getStats()` wired, no consumer); F-B7 (the control-SESSION signaling reconnect in `peer.js`
     still runs its own ICE-restart — a separate path from the transfer worker); a residual F-C4 leak
     window in `runMultiFlowReceive` (a throw in `readPersistedRanges`/`createReceiver` between the jobId
     race and the try/finally leaks the `receivePending` entry + any buffered handle — mirrors a
     pre-existing unguarded `close()` there, low-probability, ~6-line fix that also closes the older leak).
4. **Chunk manifest** — per-chunk hashing, cheap resume, within-transfer dedup, on a solid base.

Evidence + rationale: `docs/private/superpowers/audits/2026-07-19-transfer-reliability-deep-dive.md`.
