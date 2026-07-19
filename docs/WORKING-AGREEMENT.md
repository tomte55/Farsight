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
   completion/resume/hash/writer.
3. **Reliable supervisor at 8–16 flows** — speed is a hard requirement (the maintainer's link to
   his dad is slow); make high flow counts genuinely trustworthy.
4. **Chunk manifest** — per-chunk hashing, cheap resume, within-transfer dedup, on a solid base.

Evidence + rationale: `docs/private/superpowers/audits/2026-07-19-transfer-reliability-deep-dive.md`.
