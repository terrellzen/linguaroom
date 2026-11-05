# LinguaRoom V3

A small self-hosted meeting translation app. One browser microphone streams to one Node.js server, which relays mono PCM to Soniox. Read-only viewers share the same stream. Bulgarian, German, Spanish, Japanese and English are prioritized; all 60 documented Soniox languages are selectable. Source languages are detected automatically.

Audio leaves your installation for Soniox processing. This is not an offline application. A Soniox account, internet access, and available quota/payment are required. Fifteen participants taking turns is a best-effort use case; simultaneous voice separation is not guaranteed.

## Quick Start — Podman

Install Podman and a Compose provider (`podman-compose` or Docker Compose). Windows/macOS also need a running Podman Machine. See [Podman instructions](docs/PODMAN.md).

```sh
cp .env.example .env
mkdir -p certs
bash scripts/generate-dev-cert.sh localhost
```

The generated certificate is for testing. Establish browser trust as described in [HTTPS](docs/HTTPS.md), or replace it with a trusted certificate. In `.env` set:

```dotenv
HOST_PORT=3443
HOST_BIND=127.0.0.1
TLS_CERT=/app/certs/server.crt
TLS_KEY=/app/certs/server.key
```

```sh
podman compose up -d --build
podman compose logs -f
```

Open **https://localhost:3443**, use the host login code from logs, then enter the Soniox API key in the host interface. Container HTTPS is required for host access because container networking does not reliably preserve the client's localhost address. Never bake credentials into an image.

For LAN access generate/use a trusted certificate covering the host's LAN IP, set `HOST_BIND=0.0.0.0`, open the firewall, and visit `https://<host-LAN-IP>:3443`. Without `PUBLIC_ORIGIN`, each socket must have an Origin matching its actual host. Set `PUBLIC_ORIGIN` only when using one canonical URL.

Direct fallback (includes image health check):

```sh
podman build --format docker -t linguaroom:v3 .
podman run -d --name linguaroom --userns=keep-id \
  -p 127.0.0.1:3443:3000 \
  -e TLS_CERT=/app/certs/server.crt -e TLS_KEY=/app/certs/server.key \
  -v "$PWD/certs:/app/certs:ro,Z" \
  -v linguaroom-data:/app/data linguaroom:v3
podman logs linguaroom
```

Certificate ownership must permit the non-root runtime user to read it; see the platform notes. The named volume stores transcripts only when saving is enabled.

## Quick Start — Termux

Use a supported Termux distribution such as F-Droid or the official GitHub releases. Inside Termux:

```sh
pkg install git
git clone https://github.com/terrellzen/linguaroom.git
cd linguaroom
bash scripts/install-termux.sh
bash scripts/start-termux.sh
```

Open **http://localhost:3000** in the Android phone's browser. Enter the host login code from Termux, allow the microphone, and provide your Soniox key. Installation uses the checked-in lockfile and builds the same production entry point as Podman. No root, containers, Python, systemd or native audio access is required.

For another device, configure `BIND=0.0.0.0`, `PORT=3443`, certificate paths and trusted HTTPS in `.env`. Visit `https://<phone-Wi-Fi-IP>:3443`. Keep Termux and the capturing browser foreground as needed; Android may suspend or kill either process. A wake lock does not guarantee background operation. See [Termux](docs/TERMUX.md).

## Development and checks

Node 22.12+ is required (Node 22 LTS used for this build).

```sh
npm ci
npm run check
npm test
npm run lint
npm run format:check
npm run build
# Optional desktop browser smoke (synthetic microphone/provider):
npx playwright install chromium
npm run test:browser
npm start
```

Direct native development binds to `127.0.0.1:3000`. To load `.env`, run `node --env-file=.env dist/apps/server/src/main.js`. `npm start` uses the process environment. The host password is configured with `HOST_PASSWORD`, or generated at startup; it is separate from the Soniox key.

The UI includes microphone selection, pause/resume, input meter, original/translated captions, speaker renaming/correction, light/dark themes, large-text presentation, viewer links/revocation, diagnostics, JSON/TXT exports, source-timed SRT, and saved transcript download/deletion. Keys are never saved by the app; browsers/password managers remain under user control.

## Verification and limits

See [verification record](docs/VERIFICATION.md) for actual checks. Automated fixtures are synthetic. Live Soniox recognition, latency targets, 15-person diarization, physical Android capture, ARM64 containers, Windows/macOS Podman Machine and certificate trust on real devices require field testing. Provider outages require an explicit stop/start; viewer sockets reconnect automatically. No audio replay or silent continuity is promised.

SRT exports contain original speech only, because Soniox translation tokens lack timestamps. Original/translation runs are not falsely paired. Start a new meeting before the 300-minute provider limit; the app warns and ends the stream at 295 minutes. Active captions are capped at 10,000 runs; export regularly for very long meetings.

Documentation: [Architecture](docs/ARCHITECTURE.md), [Soniox](docs/SONIOX.md), [Security](docs/SECURITY.md), [Privacy](docs/PRIVACY.md), [HTTPS](docs/HTTPS.md), [Troubleshooting](docs/TROUBLESHOOTING.md), [Provider interface](docs/PROVIDER_INTERFACE.md), [Windows](docs/WINDOWS.md), [Linux](docs/LINUX.md), [macOS](docs/MACOS.md).

Application source is MIT licensed. See [dependency license inventory](docs/DEPENDENCIES.md) and retain upstream notices when distributing.
