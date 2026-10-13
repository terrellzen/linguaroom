# Verification record

Date: 2026-10-13. Host: Linux AMD64, Node 22.23.1, npm 10.9.8, rootless Podman.

| Check                                   | Result                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict frontend/backend TypeScript      | Passed `npm run check`                                                                                                                                                                        |
| ESLint                                  | Passed `npm run lint`                                                                                                                                                                         |
| Prettier                                | Passed `npm run format:check`                                                                                                                                                                 |
| Automated protocol/security/audio tests | 23 passed; one explicitly opt-in live Soniox test skipped                                                                                                                                     |
| Production build                        | Passed TypeScript compilation and Vite build; one process serves assets/API/WebSockets                                                                                                        |
| Desktop Chromium smoke                  | Passed fake microphone → AudioWorklet → host PCM → test provider → captions, pause/resume, viewer, mobile viewport and stop; no page errors                                                   |
| npm audit (all dependencies)            | Zero reported vulnerabilities at verification time                                                                                                                                            |
| Podman AMD64 multi-stage build          | Passed; direct Docker-format build preserves HEALTHCHECK                                                                                                                                      |
| Rootless container HTTPS                | Passed certificate mount with keep-id, host port publishing and CA-verified health request                                                                                                    |
| Container health/graceful shutdown      | Health check passed after startup; stop returned exit code 0                                                                                                                                  |
| Compose                                 | Parsed and structurally checked; runtime not executed because no Compose provider is installed                                                                                                |
| Termux scripts                          | Bash syntax passed; installer rejects non-Termux; two simulated Termux reruns preserve configuration/certificates/data and pass production startup checks; real pkg/npm-on-Android not tested |
| Real Android                            | Not available; installation, microphone, TLS trust, interruptions and process lifetime unverified                                                                                             |
| Live Soniox                             | No real key supplied; not executed; protocol exercised against a local synthetic WebSocket server                                                                                             |
| ARM64 / Windows / macOS                 | Architecture-neutral files supplied; physical/platform runtime and LAN networking unverified                                                                                                  |

Automated fixtures cover Bulgarian, German, Spanish, Japanese and English text but do not establish speech recognition accuracy. Source/translation runs remain independently identified; translated timings are never fabricated. SRT exports original timed speech only.

The browser smoke test is optional (`npx playwright install chromium`, `npm run test:browser`) and is not run by Termux installation. Screenshots were inspected for desktop/mobile layout; the test asserts no horizontal overflow at 390px. It uses a test-only provider injected into createApp; the production entry never exposes a mock provider.

Outstanding field tests: real Soniox key acceptance and translation quality; automatic language detection with actual mixed-language speech; one-at-a-time 15-participant diarization; actual latency distribution; multi-hour network interruption recovery; Android call/background/screen-lock behavior; trusted certificates on every client; Windows/macOS Machine port forwarding; ARM64 image execution. These are explicit verification limits, not claimed successes.

Operational limitations: one active room per process; provider reconnect requires explicit stop/start to avoid duplicate paid connections; 295-minute controlled stream end; 10,000 retained caption runs and latest 300 rendered rows; optional saved transcripts are written on orderly stop/shutdown and speaker edits, not continuously crash-safe; API keys cannot be perfectly zeroized in JavaScript; a wake lock does not guarantee Android background lifetime.
