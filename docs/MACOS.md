# macOS

Install Podman, initialize/start Podman Machine and install a Compose provider. Follow README/PODMAN.md. On Apple Silicon the official Node image has an ARM64 variant, but this repository's runtime verification was AMD64 only. Use mkcert or supplied trusted PEM files and deliberately install CA trust in Keychain/client browsers.

Certificate volume ownership and host directory sharing depend on Machine configuration. Verify published host ports and macOS firewall access from a second device. HOST_BIND=0.0.0.0 is necessary for LAN publishing but may not overcome VM localhost-only forwarding; use supported host forwarding or a host TLS reverse proxy where required. macOS physical deployment is not claimed tested.
