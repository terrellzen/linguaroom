# Android / Termux

Install a supported Termux distribution from F-Droid or official GitHub releases. Package availability varies by Android version/distribution; avoid stale installations. Install git, clone your repository, and run `bash scripts/install-termux.sh` from the checkout. No sudo/root, Docker/Podman, Python, systemd, native microphone library or chroot is used.

The installer detects Termux through PREFIX, installs nodejs-lts/git/openssl-tool, checks Node major version, runs reproducible npm ci and the shared production build, initializes .env only if missing, creates restrictive data/cert directories and runs configuration/diagnostics checks. Reruns preserve .env, data and certificates. `LINGUAROOM_DIR` selects an existing checkout; place it under Termux private home, not Android shared storage (which can prohibit executables/symlinks).

```sh
bash scripts/install-termux.sh
bash scripts/start-termux.sh
# Ctrl+C gracefully stops the foreground server.
bash scripts/diagnose-termux.sh
# With the server stopped and a clean tracked checkout:
bash scripts/update-termux.sh
```

The launcher loads .env with Node's env-file support (never shell-sources secret values), validates configuration, prints a local URL, optionally acquires a Termux wake lock, and starts the same `dist/apps/server/src/main.js` as the container. EADDRINUSE startup errors mean the configured port is occupied. Certificate file read errors identify missing/inaccessible files. It releases the wake lock on exit where supported.

Default localhost URL is http://localhost:3000. Android Chrome can request microphone permission there. Remote administration cannot use LAN HTTP. For LAN configure BIND=0.0.0.0, PORT=3443 and actual Termux TLS file paths (not /app container paths), then trust a certificate whose SAN covers the phone Wi-Fi IP. Diagnostics may be unable to list Android network addresses; use Android Wi-Fi settings. LAN URL is https://<phone-Wi-Fi-IP>:3443. Disable Wi-Fi client isolation where appropriate; verify firewall/network restrictions.

Use Android settings to permit Termux/browser microphone access and review battery optimization for both apps. Keep the capturing browser in foreground with screen awake as needed; screen locking, calls, permission revocation and browser backgrounding can interrupt capture. Android can suspend/kill Termux despite a wake lock. A foreground Termux notification and disabling battery optimization improve reliability but do not guarantee indefinite background service. This is not an Android foreground-service APK.

`npm ci` uses prebuilt Android ARM64 tooling for Vite's build dependencies where available; runtime dependencies are JavaScript. If npm cannot find a matching build-tool platform package, update the supported Termux Node/package installation; do not substitute desktop Linux binaries. Android ARM32/unsupported ABIs are not verified. Installer/update failures are actionable and preserve user data, but a failed rebuild may require rerunning installation before restart. Updates use git pull --ff-only and do not reset user files.

Physical Android microphone, TLS trust, installation and process-lifetime tests remain required. Shell syntax/static tests here are not equivalent to running on Android.
