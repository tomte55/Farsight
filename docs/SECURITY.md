# Farsight Security

Seeded in Milestone 2B (UAC posture) and expanded in Milestone 5 with the posture
summary and trust assumptions below.

## Security posture

- Transport: WebRTC DTLS-SRTP end-to-end; signaling over WSS (Let's Encrypt).
- Auth: per-launch random session password, timing-safe compare, rate-limited lockout
  (keyed per host + source IP).
- Consent: explicit Allow required on host before control; always-visible banner; panic
  hotkey (Ctrl+Alt+F12).
- Input: strict whitelist validation before injection; malformed events dropped.
- Sessions: idle + absolute timeouts auto-end a session; teardown stops screen capture.
- TURN: ephemeral HMAC credentials (short TTL); coturn denies relaying to private IP ranges.
- DoS: signaling caps payload size and per-IP connections/registrations; closes idle sockets.
- Privilege: host runs `asInvoker` (non-admin). Elevation is never automatic.
- Builds: unsigned (electron-builder signing is supported via CSC_LINK/CSC_KEY_PASSWORD but not currently configured — Windows SmartScreen may warn on first run).
- Persistent unattended credentials: argon2id hashed, opt-in, off by default.
- Logging: structured JSON events (register/connect/auth_fail/locked/disconnect); never
  passwords or SDP.

## Trust assumptions (R-8)

The self-hosted signaling server brokers the handshake and therefore **sees each session
password** (to gate connects) and relays the SDP offer/answer. A malicious or compromised
signaling server could substitute its own DTLS fingerprints and **man-in-the-middle** the
WebRTC session. Consequently the signaling server must be treated as **as trusted as the
hosts themselves** — run it on infrastructure you control.

Optional high-assurance mitigation (deferred, non-blocking): derive a Short Authentication
String from each peer's DTLS certificate fingerprint, display it on both ends, and compare
out-of-band to detect a MITM.

## Running least-privilege

Launch the host as a standard user. Some target apps running as admin will not receive
injected input by design (UIPI) — this is expected and safe.

## UAC / secure desktop (v1)
- Host runs non-admin (`asInvoker`) by default.
- Consequence 1 (UIPI): a non-elevated host cannot inject input into windows
  owned by elevated (admin) processes.
- Consequence 2 (secure desktop): UAC prompts and the lock/login screen render
  on a separate secure desktop that a user-session app cannot capture or
  control. In an attended session the person at the host handles these.
- Optional elevated mode: run the host as administrator (or install the
  elevated build variant) to drive elevated windows. The secure-desktop prompt
  itself still cannot be captured without a SYSTEM-service host (deferred
  unattended-access work).

## Software updates
Farsight apps auto-update via electron-updater from the project's GitHub
Releases. Builds are unsigned, so update integrity rests on HTTPS transport plus
electron-updater's SHA-512 verification of each artifact against the signed
`latest-*.yml` metadata on the release. The trust boundary is GitHub plus the
maintainer's release pipeline: a compromised release pipeline or maintainer
account could serve a malicious update — the same trust already required to
distribute the installers at all. Updates never apply during an active session
and never force a restart (see the auto-update design).
