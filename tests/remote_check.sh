#!/usr/bin/env bash
# Runs the webapp checks on droplet-midmain (tests do not run on the laptop).
# Copies code only (src/, tests/), never recorded data.
set -euo pipefail
HOST=${CHECK_HOST:-emanuele@100.85.38.88}
DEST=/tmp/alterego-webapp-check
REPO=$(cd "$(dirname "$0")/.." && pwd)

rsync -a --delete --exclude node_modules "$REPO/src" "$REPO/tests" "$HOST:$DEST/"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $DEST
for t in tests/*.test.cjs; do node --experimental-vm-modules "\$t"; done
tmp=\$(mktemp -d)
for f in \$(find src/js -name '*.js' ! -name 'sweetalert2.all.min.js'); do
  out="\$tmp/\${f//\//_}.mjs"; cp "\$f" "\$out"; node --check "\$out"
done
rm -rf "\$tmp"
echo "browser modules check ok"
docker run --rm -v $DEST:/w node:10-alpine sh -c 'node --check /w/src/webapp.js && node --check /w/src/js/websocket.js && echo node10 check ok'
REMOTE
