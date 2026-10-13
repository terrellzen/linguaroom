# Podman

Install Podman plus a Compose provider; `podman compose` delegates to `podman-compose` or Docker Compose and may be unavailable without one. Use `podman compose version` to check. A standalone `podman-compose up -d --build` also works where installed. No privileged access or microphone passthrough is needed.

Follow README's HTTPS setup. The container binds internally to 0.0.0.0 while publishing only host 127.0.0.1 by default. Set HOST_BIND=0.0.0.0 and HOST_PORT=3443 for opt-in LAN access. BIND and PORT in native `.env` are not container publishing controls: compose fixes the internal port at 3000. Use a certificate SAN matching every URL used and ensure browser trust.

The multi-stage Node 22 Alpine image builds assets and prunes development dependencies. Runtime uses non-root node, no Linux capabilities, read-only root filesystem, writable /tmp, read-only certificates and a named transcript volume. Source is architecture-neutral; official Node image and npm package variants support AMD64/ARM64, but ARM64 execution needs separate verification.

Compose uses `userns_mode: keep-id` so rootless certificate ownership can map correctly on Linux. For a host UID other than 1000, set an explicit Compose user matching your mapped UID/GID (and ensure named volume permissions), or use `podman unshare chown` deliberately for container UID 1000. Private keys should be readable only by the intended runtime account; never solve permissions with world-readable keys. Podman Machine mounts/ownership vary: inspect the file inside the machine and container. On SELinux, `:Z` relabels a dedicated cert directory. Do not mount an unrelated home directory.

```sh
podman compose up -d --build
podman compose logs -f
podman compose ps
podman compose down
```

`down` preserves the named data volume; do not use `down -v` unless intentionally deleting all saved data. Only opt-in transcript saving writes files. Certificates and .env are excluded from image builds. Environment secrets can be inspected by accounts able to inspect containers; prefer the host key input.

Direct fallback:

```sh
podman build --format docker -t linguaroom:v3 .
podman run -d --name linguaroom --userns=keep-id \
  -p 127.0.0.1:3443:3000 \
  -e TLS_CERT=/app/certs/server.crt -e TLS_KEY=/app/certs/server.key \
  -v "$PWD/certs:/app/certs:ro,Z" \
  -v linguaroom-data:/app/data linguaroom:v3
podman healthcheck run linguaroom
podman logs linguaroom
podman stop -t 15 linguaroom
```

Using `--format docker` preserves the Containerfile HEALTHCHECK. Compose has its own health check for OCI builds. Health checks trust the supplied certificate as a CA and validate localhost SAN; reverse-proxy health checks use local HTTP. They never disable verification. Include localhost in server certificate SANs for direct TLS health checks.

Windows/macOS: initialize and start Podman Machine, verify VM port forwarding to the host, then verify host firewall access from another device. Publishing 0.0.0.0 inside the VM alone does not guarantee LAN reachability through host forwarding. If your Podman version only forwards localhost, configure supported host port forwarding or use a host TLS reverse proxy. See platform docs. Cross-platform LAN publishing has not been tested here.
