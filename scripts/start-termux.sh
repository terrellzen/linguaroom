#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
[[ ${PREFIX:-} == *com.termux* ]] || { echo 'Run inside Termux.' >&2; exit 1; }
ROOT=${LINGUAROOM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$ROOT"
[[ -f dist/apps/server/src/main.js && -f dist/web/index.html ]] || { echo 'Build missing. Run bash scripts/install-termux.sh.' >&2; exit 1; }
[[ -f .env ]] || { echo 'Copy .env.example to .env and configure the server.' >&2; exit 1; }
node --env-file=.env --input-type=module -e 'import {config} from "./dist/apps/server/src/config.js"; const c=config(); console.log(`${c.https?"https":"http"}://localhost:${c.PORT}`); console.log(`LAN ${c.BIND==="0.0.0.0"?"enabled":"disabled"}; use phone Wi-Fi IP and trusted HTTPS.`); const net=await import("node:net"); await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once("error",()=>reject(Error("Configured port unavailable; stop the existing server or change PORT")));probe.listen(c.PORT,c.BIND,()=>probe.close(resolve));}); const os=await import("node:os"); try{for(const addresses of Object.values(os.networkInterfaces()))for(const address of addresses??[])if(address.family==="IPv4"&&!address.internal)console.log(`LAN URL: ${c.https?"https":"http"}://${address.address}:${c.PORT} (trusted HTTPS required for host)`);}catch{console.log("See Android Wi-Fi settings for the LAN IP");}'
if command -v termux-wake-lock >/dev/null; then termux-wake-lock || true; fi
trap 'command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true' EXIT
node --env-file=.env dist/apps/server/src/main.js
