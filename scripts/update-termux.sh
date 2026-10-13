#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
[[ ${PREFIX:-} == *com.termux* ]] || { echo 'Run inside Termux.' >&2; exit 1; }
ROOT=${LINGUAROOM_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$ROOT"
echo 'Stop the running server before updating. Configuration, certs and data are preserved.'
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'Commit or stash tracked changes before updating.' >&2; exit 1; }
git pull --ff-only
npm ci
npm run build
echo 'Update complete. Run bash scripts/start-termux.sh.'
