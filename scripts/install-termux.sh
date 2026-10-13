#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
trap 'echo "Installation failed at line $LINENO. Check network, storage and npm output, then rerun this script." >&2' ERR
[[ ${PREFIX:-} == *com.termux* ]] || { echo 'Run this script inside Termux on Android.' >&2; exit 1; }
command -v pkg >/dev/null || { echo 'Termux pkg is missing; install a supported Termux distribution.' >&2; exit 1; }
pkg install -y nodejs-lts git openssl-tool
ROOT=${LINGUAROOM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$ROOT"
node -e 'if(Number(process.versions.node.split(".")[0])<22)throw Error("Node 22 LTS or newer required; run pkg upgrade")'
[[ -f package-lock.json ]] || { echo 'Clone the complete LinguaRoom repository including package-lock.json.' >&2; exit 1; }
npm ci
npm run build
mkdir -p data certs
chmod 700 data certs
if [[ ! -f .env ]]; then cp .env.example .env; chmod 600 .env; fi
node --env-file=.env --input-type=module -e 'import {config} from "./dist/apps/server/src/config.js"; config();'
node --env-file=.env --input-type=module <<'JS'
import {createApp} from './dist/apps/server/src/app.js';
const {app}=await createApp(undefined,{...process.env,LOG_LEVEL:'silent',HOST_PASSWORD:'installation-check-only'});
await app.ready();
const health=await app.inject('/api/health');
if(health.statusCode!==200)throw Error('Application startup health check failed');
await app.close();
console.log('Production startup check passed');
JS
bash scripts/diagnose-termux.sh
printf '\nInstalled. Start with: bash scripts/start-termux.sh\nDefault localhost: http://localhost:3000\nLAN: https://<phone-Wi-Fi-IP>:<configured-port> (opt-in BIND=0.0.0.0 and trusted HTTPS required).\nNever submit keys over LAN HTTP. Certificates must be trusted for microphone access.\n'
