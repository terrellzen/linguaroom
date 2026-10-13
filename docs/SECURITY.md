# Security

Host access uses a random startup login code or deployment HOST_PASSWORD. Startup code logging is intentional local bootstrap; Soniox keys are never logged. Host cookies are HttpOnly, SameSite=Strict, Secure on HTTPS and expire after 12 hours. POST/DELETE endpoints require the exact application Origin, and all administrative endpoints require authenticated host access. Only loopback clients with a localhost Host may use native development HTTP; remote administration and key submission require HTTPS.

Viewer URLs carry a 256-bit random access token in their fragment. The browser removes it and uses it only for the viewer WebSocket handshake. Viewer tokens expire after 12 hours and can be rotated; viewer sockets cannot send commands or audio. Links grant transcript access: share only with intended viewers. No host credential is included. A viewer does not need a Soniox key.

Upgrade handshakes check Origin, roles and expiration. Maximum 32 client connections, 32KiB WebSocket frames, at most 64KiB host audio per second, bounded outbound buffers and ping/pong liveness protect resources. Fastify body size is 8KiB, normal HTTP requests are limited to 120/minute/IP, and login to 5/minute/IP. Host cookies are process-local; restart invalidates access. Viewer links expire independently of meeting status.

Reverse-proxy trust is opt-in, restricted to loopback or an explicitly configured PROXY_ADDRESS. Set HTTPS PUBLIC_ORIGIN and have the trusted proxy forward Origin, Host, X-Forwarded-Proto and upgrade headers. Block direct remote access to the backend. Do not enable proxy trust on an unprotected public backend.

All UI transcript content uses textContent. CSP disallows external scripts/assets, embedding and inline script execution; headers also disable MIME sniffing and referrer leakage. Exports use fixed filenames, and saved-session filenames accept UUIDs only. API keys are transient references in request/process memory, never browser storage or transcript files. JavaScript cannot guarantee memory zeroization. Optional environment keys are operator-managed secrets, inaccessible to clients.

TLS validates cert/key configuration at startup. Trust stores are never changed automatically and TLS verification is never disabled. Bind defaults to loopback; container port publishing defaults to host loopback. Saving is opt-in. Protect local data and certificate ownership, backups and logs. A process/account compromise can expose memory and transcripts. This application has not undergone an independent security audit.

Run `npm audit` for all dependencies and `npm audit --omit=dev` for runtime dependencies. Consult docs/VERIFICATION.md for the actual audit result, not a permanent guarantee.
