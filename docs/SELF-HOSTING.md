# Self-hosting Farsight

Farsight has no shared, baked-in server — you run your own signaling server and TURN relay,
and point the host + controller apps at them. This guide covers a from-scratch deployment.

## What you're deploying

- **Signaling server** (`packages/signaling-server`) — a small Node `ws` process, run in
  Docker, that brokers the WebRTC handshake (host/controller pairing, password auth,
  rate-limiting). It's the only piece of Farsight that needs to be reachable from the
  internet.
- **coturn** (`infra/coturn`) — a TURN relay used as a fallback when a direct peer-to-peer
  WebRTC connection can't be established (e.g. both sides behind strict NATs).
- **Caddy** — a TLS reverse proxy in front of both, so the signaling server is reachable over
  `wss://` with a Let's Encrypt certificate, and so coturn can reuse a Caddy-issued cert for
  `turns:`.

## Prerequisites

- A server (VM, homelab box, small VPS — anything that can run Docker and stays online) with
  a public IP and ports 80/443 reachable from the internet.
- A domain you control, with **two subdomains** pointed at the server's public IP via DNS A
  records, e.g.:
  - `signal.example.org` — the signaling server
  - `turn.example.org` — the coturn TURN relay
- Docker + Docker Compose on the server.
- [Caddy](https://caddyserver.com/) installed and running on the server (outside Docker),
  since coturn needs raw TLS on non-web ports.
- Router/firewall access, so you can forward the TURN relay's UDP/TCP port range.

## 1. Configure

Clone this repo onto the server, then:

```bash
cp infra/.env.example infra/.env
```

Edit `infra/.env` and fill in:

```
SIGNAL_DOMAIN=signal.example.org   # your signaling subdomain
TURN_DOMAIN=turn.example.org       # your TURN subdomain
DEPLOY_USER=youruser               # local OS user that owns the signaling .env
SIGNAL_COMPOSE_DIR=/srv/compose/farsight   # where this checkout lives on the server
```

## 2. Reverse proxy the signaling server

Append the block in `infra/caddy/farsight.caddy` to your server's `Caddyfile`, replacing
`signal.example.org` with your real `SIGNAL_DOMAIN` if you changed it:

```
signal.example.org {
	reverse_proxy 127.0.0.1:8090 {
		flush_interval -1
	}
}
```

Reload Caddy so it issues a Let's Encrypt certificate for the domain and starts proxying to
the signaling container (which listens on `127.0.0.1:8090` by default).

## 3. Bring up the signaling server

From the repo root on the server:

```bash
docker compose -f packages/signaling-server/docker-compose.yml up -d --build
```

Confirm `wss://<SIGNAL_DOMAIN>` is reachable (curl or a browser WebSocket test) and that the
container logs show it listening.

## 4. Deploy coturn (TURN relay)

Run the deploy script as root — it provisions a Caddy vhost for the TURN domain (to obtain a
cert), exports that cert for coturn, generates a random shared secret, starts the coturn
container, and wires the secret into the signaling server's `.env`:

```bash
sudo bash infra/coturn/deploy.sh
```

Before your first run, open these on your firewall/router (forwarded to the server):

- `3478/udp` and `3478/tcp` (TURN)
- `5349/tcp` (TURNS / TLS)
- `49160-49200/udp` (relay port range)

Re-running `deploy.sh` rotates the TURN secret and restarts both coturn and the signaling
server to pick it up — safe to do periodically.

## 5. Point the apps at your server

Farsight's host and controller apps have no baked-in signaling server. On first run, each app
prompts for a signaling URL — enter:

```
wss://signal.example.org
```

(substituting your real `SIGNAL_DOMAIN`). The value is validated (only `wss://` to a public
host, or `ws://` to `localhost`/`127.0.0.1` for local testing) and persisted per-user. You can
override it at any time by setting the `FARSIGHT_SIGNALING_URL` environment variable, which
takes precedence over the stored value.

## Notes

- The signaling server and TURN relay must both be run on infrastructure you trust — see
  `docs/SECURITY.md` for the trust model (the signaling server sees each session's password
  and relays the SDP handshake).
- TLS everywhere: the signaling server is only accepted over `wss://` (except localhost), and
  coturn's `turns:` endpoint reuses a Caddy-issued Let's Encrypt certificate.
- Certificates renew automatically via Caddy for the signaling server. coturn's copy of the
  TURN-domain certificate is a point-in-time export — plan to re-run `infra/coturn/deploy.sh`
  (or export + restart coturn) after Caddy renews it.
