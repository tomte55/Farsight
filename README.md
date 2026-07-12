# Farsight

Self-hosted, TeamViewer-like remote desktop for Windows. View and control a remote
machine over **WebRTC (DTLS-SRTP)**, brokered by your own **signaling server** and
**coturn TURN relay** — no third-party servers, no accounts, nothing in the middle.

Farsight is two Electron apps:

- **Host** — runs on the machine you want to control.
- **Controller** — runs on the machine you drive from.

> **Status:** v1 is **Windows-only** and **attended-access only** — a session starts
> only after the person at the host explicitly grants consent. There is no unattended
> mode.

## Features

- Real-time screen view and full mouse/keyboard control over WebRTC.
- **Fully self-hosted:** your own signaling server (WebSocket) + coturn TURN relay. The
  session media is peer-to-peer and end-to-end encrypted (DTLS-SRTP); the signaling
  server only brokers the handshake.
- **Attended consent:** every connection requires an explicit "Allow" on the host.
- **Per-launch session password** — generated fresh each run, shown on the host.
- **Panic hotkey** (Ctrl/Alt+F12) instantly kills any active session from the host.
- **Multi-monitor** capture with a monitor picker.
- **Auto-update** — apps update themselves from GitHub Releases, and never restart in
  the middle of an active session.
- **Bring your own server:** apps have no baked-in signaling URL — you point them at
  your own on first run.

## How it works

```
 Controller  ⇄  Signaling server (WSS)  ⇄  Host
      \                                     /
       └──────  WebRTC P2P (DTLS-SRTP) ─────┘
              (TURN relay only if needed)
```

The signaling server exchanges the WebRTC offer/answer and hands out short-lived TURN
credentials after the controller authenticates. Once the peer connection is
established, screen and input flow directly between the two machines (or via your TURN
relay when a direct path isn't possible) — encrypted end to end.

## Install & use

1. Download the **Farsight Host** and **Farsight Controller** installers from the
   [Releases](https://github.com/tomte55/Farsight/releases) page.
   > Builds are unsigned, so Windows SmartScreen may warn on first run
   > (**More info → Run anyway**).
2. Run **Host** on the machine to be controlled, **Controller** on the machine you
   drive from.
3. On first launch, each app asks for your **signaling server URL** (`wss://…`) — enter
   the address of the server you set up below. You can change it anytime in settings.
4. The host shows an **ID** and a **password**. Enter them in the controller, and
   **Allow** the connection on the host.

Don't have a server yet? See **[Self-hosting guide](docs/SELF-HOSTING.md)**.

## Self-hosting the server

Farsight needs a signaling server and a TURN relay that you run. The
[**Self-hosting guide**](docs/SELF-HOSTING.md) walks through standing them up with
Docker + Caddy (TLS) on your own host, parameterized by your domain via `infra/.env`.

At a glance:

- **Signaling server** — `packages/signaling-server` (Node `ws`, Docker), behind a TLS
  reverse proxy (Caddy) → gives you the `wss://` endpoint the apps connect to.
- **TURN relay** — coturn, configured by `infra/coturn/deploy.sh` (generates its own
  shared secret at deploy time; nothing sensitive is committed).

## Development

Farsight is an npm-workspaces monorepo:

| Package | Purpose |
|---|---|
| `packages/shared` | Runtime-agnostic logic (protocol, input/control validation, config, update policy) — unit-tested in isolation |
| `packages/signaling-server` | The only internet-facing runtime: `ws` signaling with password auth, rate-limiting, per-IP DoS limits |
| `packages/host` / `packages/controller` | The Electron apps (`main.js`, sandboxed `preload.cjs` + renderer) |

Run everything locally on a LAN:

```bash
# 1. Start local signaling
node packages/signaling-server/src/server.js

# 2. Point the apps at it (env overrides the stored URL), then start them
FARSIGHT_SIGNALING_URL=ws://127.0.0.1:8080 npm start -w @farsight/host
FARSIGHT_SIGNALING_URL=ws://127.0.0.1:8080 npm start -w @farsight/controller
```

Run the test suite:

```bash
npx vitest run
```

Releases are cut by pushing a version tag (`vX.Y.Z`) — GitHub Actions builds the
Windows installers and publishes a GitHub Release.

## Security

Farsight is attended-access only, uses a fresh per-launch session password, and
encrypts session media end-to-end with DTLS-SRTP. The self-hosted signaling server
brokers the handshake and must be treated as trusted. Builds are currently unsigned.
See **[SECURITY.md](docs/SECURITY.md)** for the full trust model and threat notes.

## License

[MIT](LICENSE) © tomte55
