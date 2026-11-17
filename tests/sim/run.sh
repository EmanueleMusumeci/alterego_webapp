#!/bin/sh
# From the laptop: copy code to droplet-midmain, (re)build the simulated robot, run the scenarios there.
# Usage: bash tests/sim/run.sh [scenario ...]
set -eu
HOST=${CHECK_HOST:-emanuele@100.85.38.88}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
ssh "$HOST" 'mkdir -p /tmp/alterego-sim/w /tmp/alterego-sim/tests'
rsync -a --delete --exclude node_modules --exclude state.json --exclude settings.json "$REPO/src/" "$HOST:/tmp/alterego-sim/w/src/"
rsync -a --delete "$REPO/tests/sim" "$HOST:/tmp/alterego-sim/tests/"
ssh "$HOST" "set -e; cd /tmp/alterego-sim/w; [ -d node_modules/ssh2 ] || cp -a /tmp/alterego-webapp-check/node_modules .
  sh /tmp/alterego-sim/tests/sim/setup.sh >/dev/null 2>&1
  docker image inspect alterego-sim-runner >/dev/null 2>&1 || docker build -q -t alterego-sim-runner -f /tmp/alterego-sim/tests/sim/Dockerfile.runner /tmp/alterego-sim/tests/sim >/dev/null
  docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v /tmp/alterego-sim:/sim \
    -w /sim/tests/sim alterego-sim-runner python3 -u scenarios.py $*"
