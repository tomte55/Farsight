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

## Unified-app control reachability (R-9)

Before the unification, only the dedicated host app had an inbound control surface — a plain
controller install could not be connected to at all. Merging host capability into the unified
app (host + controller + file-share in one) changes that: **every unified install can register
with signaling and be controlled**, not just machines the maintainer deliberately set up as hosts.

The mitigation is a receiver-side, persisted setting, **"Allow this computer to be controlled"**
(`controlAllowed` in `config.json`, **default on** when unset). When off, the app never creates the
host-registration signaling client in the first place — it does not register with signaling at
all, so there is nothing to connect to (fails closed, not merely UI-hidden). Toggling the setting
off while a session is already active immediately ends that session
(`endSessionByHost('control_disabled', …)`) rather than leaving it running unmanaged.

Being registered and reachable does not by itself mean controllable — an inbound connect still has
to clear the pre-existing layers, unchanged by unification:
- **Ad-hoc (id + password):** the rotating 6-character session password (regenerated hourly and on
  demand), signaling's password check with rate-limited lockout and per-IP DoS limits, and the
  **attended consent prompt** on the receiving install (explicit "Allow" required; no auto-accept).
- **Own-fleet linked:** no session password and no per-connect prompt — the account login on the
  receiving machine is the standing consent (see "Connect-from-console" below) — but input stays
  blocked until the mutual device-keypair handshake completes (`session.isActive() && (!linkedConnect
  || peerAuthed)`). `conn-auth:is-account-key` checks only the signed-in owner's own enrolled fleet
  (`isAccountPublicKey`) and is intentionally never widened to contacts: a file-transfer contact
  cannot use that trust tier to remote-control a machine.
- The **panic hotkey** (Ctrl+Alt+F12) ends any session from the receiving side regardless of path.

The unified app now runs as a tray app (closing the window hides it to the tray instead of quitting)
so it stays reachable for legitimate use — the same property that keeps the control surface live is
what makes the "Allow this computer to be controlled" toggle the operative control, not app exit.

**Accepted residual risk:** because the toggle defaults on, a freshly installed unified app is
control-reachable out of the box, gated by the password + attended consent (ad-hoc) or the
device-keypair handshake (own fleet) — never bare. The maintainer's practice is to turn the toggle
off on machines that should never be driven (e.g., installs that only send/receive files or only
act as a controller).

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

## File transfer (SP3)
File transfer runs over its **own dedicated RTCPeerConnection** (a hidden
transfer-worker window with its own signaling session, `CONNECT kind:'transfer'`),
independent of any control session — so it never blocks the cursor and a host can
serve a transfer while being controlled. It is a **consented push with a manifest**:
the sender offers a specific file/folder set; the receiver sees a file-tree preview
(paths + sizes) and must accept before any bytes flow. There is **no filesystem
access to the peer** — only the declared set moves. Received paths are re-validated
against a traversal guard (`sanitizeRelativePath` / `buildManifest`) and confined to
the chosen destination root; each file is streamed to a `.part` file and
**hash-verified on completion** before finalize; wire-declared totals are advisory
(recomputed from the re-validated manifest). No fixed size cap — streamed to disk.

**Two trust tiers gate how a transfer is authenticated:**

- **Ad-hoc (id + session password).** A stranger/one-off (e.g. "send a folder to
  dad"): the signaling server gates the pairing on the session password, and the
  receiver consents per transfer. This is the shipped flagship.
- **Own fleet (account-linked, device-keypair).** For your own account-linked
  devices the console offers a **password-free "Send…"**. As with connect-from-console
  (§ "Connect-from-console"), signaling stays account-oblivious — a `linked` transfer
  pairs without the password gate (relay only) — and the real authentication is
  **end-to-end**: after DTLS forms, both transfer workers run the **same mutual
  device-keypair handshake over a dedicated `auth` data channel**, each proving an
  account-enrolled device key, with the signed transcript **bound to the DTLS
  fingerprints** (defeats the R-8 SDP-swap MITM for the linked path). It **fails
  closed**: the sender withholds the manifest OFFER and all bytes, and the receiver
  refuses to process an OFFER, until the handshake passes; an unverifiable peer is
  torn down and no `.part` is ever opened. This is the gate the future own-fleet
  remote-FS server will sit behind (own-fleet only). The receiver still shows a
  per-transfer consent prompt today (own-fleet consent-free push is a later choice).
  **Residual:** as elsewhere, the account is the fleet key — protect it (argon2id,
  optional TOTP).

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

## Diagnostics upload
Both apps offer a "Send diagnostics to support" action (host tray menu; controller
Settings menu) that uploads the current log bundle to the account server's
`POST /diagnostics`. It is:
- **Account-authenticated** — shown only when signed in, and sent with the
  account's short-lived access token; there is no anonymous upload endpoint.
- **User-consented** — a native dialog states the scope ("never your password,
  screen contents, or file contents") and requires an explicit Send click; a
  Cancel (or dismissed dialog) uploads nothing.
- **Redaction-safe by construction** — the bundle is built from `*.log`/`*.log.N`
  files under the app's own log directory only (`buildDiagnosticsBundle`); it
  never includes `config.json`, the encrypted token/device-key files, or any
  other userData contents, so it inherits the same never-log-secrets guarantee
  as the logs themselves.
- **Server-side TTL-pruned** — uploads land under the account server's data
  volume (`diagnostics/`) and are deleted after `ACCOUNT_DIAGNOSTICS_TTL_DAYS`
  (default 30; see `docs/SELF-HOSTING.md`), swept on startup and daily.
