# Windows

Primary deployment is Podman with Podman Machine. Install a supported Podman distribution and a Compose provider, run `podman machine init` if needed and `podman machine start`, then follow README/PODMAN.md. Git Bash can run certificate scripts; PowerShell users can use mkcert or supplied certificates. Direct native Node uses the same compiled server but is not the primary supported deployment path.

Use Podman Machine's supported host-directory mount syntax for certificates. The direct-run `$PWD` example is POSIX shell syntax; PowerShell should supply an explicit absolute directory in the volume argument. Verify runtime file permissions inside the VM. Set HOST_BIND=0.0.0.0 for LAN publishing, inspect host forwarding, and allow only the required port/network profile in Windows Defender Firewall. Open https://<Windows-host-LAN-IP>:3443 from another device; do not use the VM's private address unless deliberately routed.

Install/trust your local CA intentionally in Windows and client devices; never disable verification. Windows Machine forwarding, ARM64 and firewall behavior remain unverified in this environment.
