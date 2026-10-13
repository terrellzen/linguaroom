# Implementation checklist

- [x] Foundation: strict TypeScript, normalized protocol, provider interface, sessions, tests
- [x] Soniox: authenticated relay, token revision normalization, bounded transport, lifecycle
- [x] Browser: AudioWorklet PCM, captions, speaker controls, responsive presentation
- [x] Security: host/viewer permissions, origins, HTTPS, resource limits, key handling
- [x] Podman: multi-stage container, Compose, health and shutdown
- [x] Termux: repeatable install/start/update/diagnostics
- [x] Features: exports, optional persistence, diagnostics, sharing
- [x] Verification: checks, tests, build, audit, available runtime smoke tests

Live Soniox accuracy, physical Android microphone/background behavior, and multi-platform Podman networking require external verification. Synthetic tests do not establish recognition accuracy.

Detailed results and outstanding external tests: [VERIFICATION.md](VERIFICATION.md). Browser testing uses a synthetic microphone and test-only provider; production has no mock switch.
