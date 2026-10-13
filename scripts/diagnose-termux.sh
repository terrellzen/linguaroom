#!/usr/bin/env bash
set -euo pipefail
ROOT=${LINGUAROOM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$ROOT"
for package in node npm git openssl; do command -v "$package" || true; done
node --version
node -e 'console.log("LinguaRoom",JSON.parse(require("node:fs").readFileSync("package.json")).version)'
if command -v ip >/dev/null; then ip -brief address 2>/dev/null || echo 'Android restricted network address listing; see Wi-Fi settings.'; fi
[[ -w data ]] && echo 'Data directory writable' || echo 'Data directory missing or not writable'
node --env-file=.env --input-type=module <<'JS'
import {config} from './dist/apps/server/src/config.js';
import net from 'node:net';
const c=config(); console.log(`Bind ${c.BIND}:${c.PORT}; TLS ${c.https?'configured (trust not verified)':'disabled'}`);
const s=net.createServer();s.on('error',()=>console.log('Port occupied or unavailable'));s.listen(c.PORT,c.BIND,()=>{console.log('Port available');s.close();});
try {const r=await fetch(`http${c.https?'s':''}://localhost:${c.PORT}/api/health`); console.log('Health status',r.status);}catch{console.log('Health not reachable (server stopped or TLS not trusted).');}
JS
