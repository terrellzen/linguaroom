# Provider interface

`SpeechProvider` exposes id, initialize, capabilities and create(key, options, callbacks). Capabilities advertise translation, diarization and language support. `create` returns `SpeechStream` with bounded `audio(Buffer): boolean` and graceful asynchronous `end()`. Callbacks deliver normalized segments, connection states, errors and usage metrics.

A false audio return means the chunk was not accepted; callers count it as lost. Implementations must bound queues, initialize one remote stream per session, validate provider replies, sanitize errors, retain no key in transcript objects, support final/provisional revision semantics and clean up timers/sockets on termination. Provider errors cannot silently open another billable stream.

Soniox-specific configuration and token JSON are restricted to `providers/soniox`. Future adapters must map to the normalized protocol; do not expose a raw provider response to viewers. Only the test suite supplies a simulated provider. There are no hypothetical production providers or local inference dependencies.
