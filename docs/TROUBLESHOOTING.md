# Troubleshooting

| Symptom                      | Check                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Missing microphone APIs      | Browser secure context, trusted certificate SAN, localhost versus LAN, current AudioWorklet-supporting browser      |
| Permission denied            | Browser/site microphone permission and Android permission; choose the correct input device                          |
| Host forbidden over HTTP     | Remote host administration requires HTTPS; container NAT means localhost publishing may still require HTTPS         |
| Origin rejected              | Actual Origin must match scheme/Host or PUBLIC_ORIGIN; use the canonical configured URL                             |
| Soniox rejected/fails        | API key, temporary credential expiry, quota/payment, internet and current model availability; stop/start explicitly |
| Backlog or missing captions  | Network loss, dropped-byte/queue metrics, input meter, server logs; no replay of lost audio                         |
| Browser backgrounded         | Android may suspend capture; foreground browser, screen and battery settings                                        |
| Address already in use       | Stop the existing server or select another valid port                                                               |
| Certificate permission error | Restrictive key must be readable by mapped non-root runtime user; check rootless keep-id and VM mounts              |
| Health check TLS failure     | Include localhost SAN and supply a certificate/CA chain trusted by the check; do not disable verification           |
| Compose unavailable          | Install podman-compose/Docker Compose or use direct build/run fallback                                              |
| LAN unreachable              | Bind/published address, VM forwarding, host firewall, Wi-Fi isolation, URL's host LAN IP                            |
| Viewer disconnected          | Link expiry/revocation, Origin/TLS, server restart; get a fresh link from host                                      |
| No SRT translation           | Translation tokens have no timestamps; SRT uses timed original speech; use TXT/JSON for translation                 |
| Empty saved list             | Saving is opt-in, written on orderly stop/shutdown; in-memory sessions disappear after restart                      |

Start/stop controls operate one session. Stop before changing language, testing a key or clearing captions. Pause suspends microphone capture but keeps the authenticated provider connection open. Additional viewers consume network resources but do not create more Soniox connections.
