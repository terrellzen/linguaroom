# Linux

Install rootless Podman, ensure your user has configured subordinate UID/GID ranges, and install a Compose provider. Follow README and PODMAN.md. Do not run the application privileged or pass host audio devices. Keep certificate keys restrictive; Compose uses keep-id mapping, and dedicated cert mounts use SELinux :Z relabeling where relevant.

For LAN access set HOST_BIND=0.0.0.0, use trusted HTTPS with your LAN IP/hostname SAN, and open the published TCP port in your firewall for the intended subnet. Native development can use npm ci, npm run build, npm start on localhost. See VERIFICATION.md for actual container checks.
