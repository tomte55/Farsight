# Farsight

Self-hosted, TeamViewer-like remote desktop for Windows. Control another machine, let
someone control yours, and transfer files — over **WebRTC (DTLS-SRTP)**, brokered by
your own **signaling server** and **coturn TURN relay**. No third-party servers; the
session media never touches anything in the middle.

Farsight is **one app**. Install it on every machine — each one can drive others, be
driven, and send/receive files.

> **Status:** Windows-only. **Attended by default** — a remote-control session starts
> only after the person at the target clicks **Allow**. Machines you link to your own
> account can be reached **unattended** (your account login on that machine is the
> standing consent), still gated by a device-keypair handshake. Whether a machine
> accepts inbound control at all is a toggle you own (**default on**).

## Features

- **Real-time screen view + full mouse/keyboard control** over WebRTC.
- **Fully self-hosted:** your own signaling server (WebSocket) + coturn TURN relay.
  Session media is peer-to-peer and end-to-end encrypted (DTLS-SRTP); the signaling
  server only brokers the handshake.
- **File transfer** — send big files *and* whole folders directly to another machine,
  streamed to disk, chunked and integrity-checked, with **durable resume** (a dropped
  transfer continues from the last verified chunk and survives an app restart). Works
  standalone — no screen-share needed.
- **"Allow this computer to be controlled"** — a per-machine toggle (default on). Off,
  the machine is unreachable for control but still usable for file transfer.
- **Attended consent** for ad-hoc connections; **per-launch session password** (rotates
  hourly and on demand).
- **Panic hotkey** (Ctrl+Alt+F12) instantly kills any active session.
- **Multi-monitor** capture with a monitor picker.
- **Optional account** — sign in to keep a **saved fleet** of your machines with live
  online/version presence, connect to them password-free, keep them updated remotely,
  and add **contacts** (a friends list) to transfer files account-to-account. No account
  is required for the ad-hoc ID + password path.
- **Auto-update** from GitHub Releases — never restarts in the middle of an active session.
- **Tray app** — closing the window keeps it running (so it stays reachable); quit from
  the tray.
- **Bring your own server:** no baked-in signaling URL — point the app at yours on first run.

## How it works

```
  Farsight  ⇄  Signaling server (WSS)  ⇄  Farsight
      \                                     /
       └──────  WebRTC P2P (DTLS-SRTP) ─────┘
              (TURN relay only if needed)
```

The signaling server exchanges the WebRTC offer/answer and hands out short-lived TURN
credentials after the connecting side authenticates. Once the peer connection is
established, screen, input, and files flow directly between the two machines (or via
your TURN relay when a direct path isn't possible) — encrypted end to end.

## Install & use

1. Download the **Farsight** installer from the
   [Releases](https://github.com/tomte55/Farsight/releases) page and run it on every
   machine.
   > Builds are unsigned, so Windows SmartScreen may warn on first run
   > (**More info → Run anyway**).
2. On first launch, enter your **signaling server URL** (`wss://…`) — the server you set
   up below. You can change it anytime in settings.
3. **To control a machine:** on the target, read the **ID** and **password** shown on its
   Home screen; enter them on the machine you're driving from and click **Connect**, then
   **Allow** on the target.
4. **To send files:** open **Transfers → Send files…** (or use a saved fleet / contact
   row), pick files or a folder, and the receiver accepts.

> **Upgrading from Farsight v1** (the old separate *Host* and *Controller* apps)? v2 is a
> fresh install with a new identity, so it won't auto-update from v1 — download and run
> the installer once. The old apps can be uninstalled.

Don't have a server yet? See **[Self-hosting guide](docs/SELF-HOSTING.md)**.

## Self-hosting the server

Farsight needs a signaling server and a TURN relay that you run. The
[**Self-hosting guide**](docs/SELF-HOSTING.md) walks through standing them up with
Docker + Caddy (TLS) on your own host, parameterized by your domain via `infra/.env`.

At a glance:

- **Signaling server** — `packages/signaling-server` (Node `ws`, Docker), behind a TLS
  reverse proxy (Caddy) → gives you the `wss://` endpoint the app connects to.
- **TURN relay** — coturn, configured by `infra/coturn/deploy.sh` (generates its own
  shared secret at deploy time; nothing sensitive is committed).
- **Account server** (*optional*) — `packages/account-server` (Node/TS, Prisma+SQLite),
  only needed for the saved-fleet console, contacts, and remote update. The ad-hoc
  ID + password path works without it.

## Development

Farsight is an npm-workspaces monorepo:

| Package | Purpose |
|---|---|
| `packages/shared` | Runtime-agnostic logic (protocol, input/control validation, transfer engine, config, update policy) — unit-tested in isolation |
| `packages/signaling-server` | The only internet-facing runtime: `ws` signaling with password auth, rate-limiting, per-IP DoS limits |
| `packages/controller` | The unified **Farsight** Electron app (`main.js`, sandboxed `preload.cjs` + renderer shell + a session window) |
| `packages/account-server` | Optional account service (accounts, fleet, contacts, remote update) |
| `packages/host` | The **retired** v1 host app — kept for history; no longer built |

Run it locally on a LAN:

```bash
# 1. Start local signaling
node packages/signaling-server/src/server.js

# 2. Point the app at it (env overrides the stored URL) and start it.
#    Run a second instance on another machine to control it.
FARSIGHT_SIGNALING_URL=ws://127.0.0.1:8080 npm start -w @farsight/controller
```

Run the test suite:

```bash
npx vitest run
```

Releases are cut by pushing a version tag (`vX.Y.Z`) — GitHub Actions builds the Windows
installer and publishes a GitHub Release. Don't build installers locally.

## Security

Farsight is attended by default, uses a fresh per-launch (rotating) session password, and
encrypts session media end-to-end with DTLS-SRTP. Whether a machine accepts inbound
control is a receiver-side toggle (default on); own-fleet unattended connect is gated by a
device-keypair handshake bound to your account. The self-hosted signaling server brokers
the handshake and must be treated as trusted. Builds are currently unsigned. See
**[SECURITY.md](docs/SECURITY.md)** for the full trust model and threat notes.

## Known limitations

- **Ctrl+Alt+Del / secure-attention** cannot be sent to a remote Windows machine. The
  Secure Attention Sequence is handled by the Windows kernel and cannot be triggered by
  injected keystrokes; the `SendSAS` API requires a UIAccess-signed binary or a service.
  This is gated on code signing plus a small privileged helper, and is on the roadmap
  rather than faked with a button that silently does nothing.
- **Builds are unsigned**, so Windows SmartScreen warns on first run. Code signing is
  wired in CI and activates once a certificate secret is added (see `docs/SECURITY.md`).
- **Clipboard sync** covers text (not images/files).
- **HDR displays** can look washed-out when captured (SDR-correct first; HDR is a
  follow-up).

## License

[MIT](LICENSE) © tomte55
