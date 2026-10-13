#!/usr/bin/env bash
set -euo pipefail
command -v openssl >/dev/null || { echo 'Install OpenSSL or use mkcert; see docs/HTTPS.md.' >&2; exit 1; }
NAME=${1:-localhost}
[[ $NAME =~ ^[a-zA-Z0-9.:_-]+$ ]] || { echo 'Provide a hostname or IP without spaces.' >&2; exit 1; }
mkdir -p certs
[[ ! -e certs/server.key && ! -e certs/server.crt ]] || { echo 'Certificates already exist; move them explicitly before regenerating.' >&2; exit 1; }
umask 077
SAN="DNS:localhost,IP:127.0.0.1"
if [[ $NAME =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || $NAME == *:* ]]; then SAN="$SAN,IP:$NAME"; else SAN="$SAN,DNS:$NAME"; fi
openssl req -x509 -newkey rsa:3072 -sha256 -days 30 -nodes -keyout certs/server.key -out certs/server.crt -subj '/CN=LinguaRoom LAN test' -addext "subjectAltName=$SAN"
echo 'Created self-signed test certificate. This does NOT establish browser trust. See docs/HTTPS.md.'
