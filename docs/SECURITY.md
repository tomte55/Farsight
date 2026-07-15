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
- Builds: unsigned (electron-builder signing is supported via CSC_LINK/CSC_KEY_PASSWORD but not currently configured — Windows SmartScreen may warn on first run). Signing is NOT wired into the release CI (`.github/workflows/release.yml`) by default — electron-builder 24.x fails the build on an empty `CSC_LINK`, so the vars are intentionally left out. To enable signing, add the `CSC_LINK` (base64-encoded .pfx) and `CSC_KEY_PASSWORD` repo secrets AND add the documented `env:` block to the two build steps; until then, builds remain unsigned.
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

## Connect-from-console (account-linked device-keypair auth)

For your own account-linked fleet, the console can connect **without a session password**. This does
not weaken the trust model:

- **Signaling stays account-oblivious.** A host opts in with an `acceptsLinked` flag; a `linked`
  CONNECT then pairs the two sockets without the password check. That grants only a *relay* — the
  signaling server never learns accounts, keys, or identities.
- **Auth is end-to-end.** After WebRTC/DTLS forms, the two devices run a **mutual Ed25519
  challenge-response** over a dedicated `auth` data channel, each proving possession of an
  account-issued device key whose public half is enrolled under the owner's account (verified via the
  owner-authenticated `GET /devices`). Private keys live only in OS-encrypted storage (safeStorage /
  DPAPI) in the main process — never in a renderer or on the wire.
- **Bound to the DTLS fingerprints.** The signed transcript includes both peers' DTLS certificate
  fingerprints, so the R-8 SDP-swap MITM is **defeated for the linked path**: a signaling server that
  substituted fingerprints makes the two transcripts diverge and the signatures fail. This realizes
  the R-8 mitigation for account-linked connects.
- **No per-session prompt for your own fleet; control gated on auth.** A linked connect to a device
  you've linked to your own account does **not** raise a consent prompt — logging into your account on
  that machine is the standing consent (§4.3, now extended from silent *update* to silent *control* of
  your own devices, the TeamViewer unattended-own-device model). The host still shows an active-session
  banner (visible indication it's being controlled) but requires no click. **Control is gated on the
  keypair handshake:** input injection stays blocked until it passes, and the controller does not reveal
  the remote screen until it has verified the host — an unverifiable peer is denied control, shown
  nothing, and the session is torn down (fails closed). **Ad-hoc / id+password connects still require
  explicit per-session consent** (a stranger with your session password gets an attended prompt, never
  unattended control). Consequence: the account is now the master key to *unattended control* of your
  fleet, not just updates — so account security (argon2id, optional TOTP, 2FA on the release account)
  is even more load-bearing.
- **Residual:** the account is the fleet master key — a compromised account could dial its own fleet
  (the same property as remote update, §4.3). Protect it: argon2id password hashing, optional TOTP,
  and 2FA on the GitHub release account.

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

**Remote update (S2.7): account-linked, converge-to-official-feed.** The owner can trigger a linked
host to install its pending update from the console, with no per-update prompt on the host — logging
into your account on that machine is the standing consent (§4.3). The directive is delivered as a
**target version string** on the host's presence heartbeat, never a binary: the host still installs
**only** the official GitHub-feed release (HTTPS + sha512-verified), so a compromised account can at
most trigger a converge-to-latest or a no-op — it can never hand a host an arbitrary binary. The
install still defers across an active session and only ever applies the official signed feed. Only
account-linked hosts are remotely updatable (an unlinked host has no heartbeat directive) — the same
management gate as connect-from-console. This makes the account the master key to keeping the fleet
current, reinforcing that account security (argon2id, optional TOTP, GitHub-release-account 2FA) is
load-bearing.

## Clipboard sync
During an active session, clipboard TEXT is synchronized in both directions
(bounded to 100000 chars) over the encrypted control channel. This is within
the attended-control trust model (the controller already has full input/screen
access), but be aware sensitive clipboard contents are shared while a session
is active.

## File transfer
During an active session, either side can send an arbitrary file to the other
over a dedicated reliable, ordered data channel (separate from input/control,
so a transfer never blocks the cursor or session control). Transfers are
bounded to 100 MB; the receiving side additionally caps total bytes received
at that limit regardless of the declared size, in case a peer sends more than
it announced. Received filenames are always sanitized to a basename (path
separators and `..` stripped, falling back to `"download"`) before the save
path is chosen, preventing path traversal. Saving always goes through a
user-driven OS Save dialog — nothing is written to disk without the receiving
user picking a location. This is within the attended-control trust model (the
controller already has full input/screen access, and the host user has
already granted consent).

## Logs
Each app writes a rotating, human-readable log to its per-user data directory:

- Host: `%APPDATA%\Farsight Host\logs\main.log`
- Controller: `%APPDATA%\Farsight Controller\logs\main.log`

(In an unpackaged dev run the folder is the scoped package name, e.g.
`%APPDATA%\@farsight\host\logs\main.log`.) The file rotates at 2 MB and keeps two
generations (`main.log` + `main.log.1`); reach it from the host tray
("Open logs folder") or the controller Settings menu.

Logs capture lifecycle/session events, IPC and handler errors, main-process
crashes and unhandled rejections, and forwarded renderer errors. By design they
**never contain secrets**: the session password, SDP/ICE candidates, clipboard
text, and file-transfer contents are never logged — clipboard/file operations
log byte counts only, and every line is truncated to 2000 chars as a backstop.
The default level is `info` (packaged) / `debug` (dev); override with
`FARSIGHT_LOG_LEVEL` (`debug`|`info`|`warn`|`error`).
