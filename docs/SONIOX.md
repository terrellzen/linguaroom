# Soniox integration

Verified against official documentation on 2026-10-13:

- [WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api)
- [Real-time translation](https://soniox.com/docs/translation/stt-translation/rt-translation)
- [Audio formats](https://soniox.com/docs/stt/rt/real-time-transcription)
- [Endpoint detection](https://soniox.com/docs/stt/rt/endpoint-detection)
- [Languages](https://soniox.com/docs/translation/supported-languages)

The backend connects to `wss://stt-rt.soniox.com/transcribe-websocket` with `Authorization: Bearer <key>` and configures `stt-rt-v5`, `pcm_s16le`, 16,000Hz, one channel, language identification, configurable speaker diarization and endpoint detection, plus `translation: {type: "one_way", target_language: ...}`. It sends no api_key in configuration and uses no restrictive language hints.

The adapter validates responses, separates translation tokens, carries source language and speaker labels, appends final deltas once and replaces provisional suffixes. Translated tokens have no invented timestamps. `<end>` / `<fin>` markers are control boundaries, never visible caption words. One empty text frame ends audio; an empty binary frame does not. Keepalive runs every 15 seconds.

Errors expose sanitized status/type and actionable advice, not provider error text that might contain sensitive data. Unauthorized keys, temporary credential expiry, quota/payment failures and disconnects require host intervention. The app never automatically opens a second paid stream after a failure. Stop/start establishes a new stream and new meeting ID. Audio during outages is dropped with warnings. At 295 minutes the adapter warns and ends before Soniox's documented 300-minute stream limit.

Connection test opens and ends a short stream and may incur provider charges. It proves connection acceptance, not recognition accuracy. A separate optional integration test requires `RUN_LIVE_SONIOX=1` and `SONIOX_TEST_KEY` in the environment; it is skipped by default. Never put keys in commands saved to shell history or committed files.
