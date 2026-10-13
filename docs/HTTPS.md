# HTTPS and LAN

Native developer HTTP is allowed only for trusted localhost access (client and Host both loopback). LAN HTTP usually lacks microphone APIs and is prohibited for host administration/key submission. Containers should use HTTPS even through a localhost published port because NAT may hide loopback client addresses.

Set TLS_CERT and TLS_KEY to PEM certificate/private-key files and PORT as needed. Both must exist and match; Node validates them at startup. Use BIND=0.0.0.0 only for deliberate LAN exposure. Certificate SAN must include the selected hostname/IP; CN alone is insufficient. Private keys and certificates are ignored by Git and excluded from images.

For LAN testing:

```sh
bash scripts/generate-dev-cert.sh 192.168.2.150
```

The script includes localhost/127.0.0.1 plus the selected DNS name or IPv4/IPv6 SAN, refuses overwrites and creates a restrictive key. It does not install trust. A self-signed certificate warning bypass does not necessarily make getUserMedia available. Verify `window.isSecureContext`, browser device permissions and valid certificate trust.

Prefer a locally trusted development CA through mkcert, installed explicitly by the operator:

```sh
mkdir -p certs
mkcert -cert-file certs/server.crt -key-file certs/server.key localhost 127.0.0.1 192.168.2.150
```

Follow mkcert's instructions to install its root CA on each relevant device. This application never invokes trust-store changes. Protect the CA private key and never distribute it. Distribute only the CA certificate to trusted clients. For Android, use Settings → Security/Encryption & credentials → Install certificate → CA certificate (labels vary), and verify your browser accepts user-installed CAs. Managed-device policy can block this. Windows uses the user/machine trusted root store; macOS Keychain trust; Linux depends on OS and browser stores, particularly Firefox. Trust changes require deliberate operator action.

Platform-neutral alternative without OpenSSL/mkcert: obtain a certificate from an organization's trusted CA or a public CA for a hostname you control, using a platform-supported certificate client or managed reverse proxy. Configure DNS to the LAN host, provide the issued PEM chain/key, and open the matching HTTPS hostname. Public CAs generally do not issue private-IP certificates. An existing trusted reverse proxy can terminate TLS without local certificate generation.

Reverse proxy: set TRUST_PROXY=true, PUBLIC_ORIGIN=https://your-hostname, and PROXY_ADDRESS to the exact proxy IP if not loopback. The proxy must forward Host, Origin, X-Forwarded-Proto=https and WebSocket upgrade headers, with appropriate timeout/body limits. Only trusted proxy addresses affect scheme detection. Keep the backend unreachable directly from untrusted clients. No TLS verification is disabled.

In Compose, use container paths /app/certs/server.crt and /app/certs/server.key. Native Node/Termux uses actual filesystem paths. Rootless file ownership must allow the runtime user to read restrictive keys. See PODMAN.md. The container health check expects localhost as a SAN.
