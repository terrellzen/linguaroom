# Implementation checklist

- [ ] Foundation: strict TypeScript, normalized protocol, provider interface, sessions, tests
- [ ] Soniox: authenticated relay, token revision normalization, bounded transport, lifecycle
- [ ] Browser: AudioWorklet PCM, captions, speaker controls, responsive presentation
- [ ] Security: host/viewer permissions, origins, HTTPS, resource limits, key handling
- [ ] Podman: multi-stage container, Compose, health and shutdown
- [ ] Termux: repeatable install/start/update/diagnostics
- [ ] Features: exports, optional persistence, diagnostics, sharing
- [ ] Verification: checks, tests, build, audit, available runtime smoke tests

Live Soniox accuracy, physical Android microphone/background behavior, and multi-platform Podman networking require external verification. Synthetic tests do not establish recognition accuracy.
