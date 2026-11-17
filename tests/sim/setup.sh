#!/bin/sh
# (Re)create the simulated robot on droplet-midmain. Code is mounted from $SIM/w (a copy of src/).
set -eu
SIM=/tmp/alterego-sim
docker build -q -t alterego-sim "$SIM/tests/sim" >/dev/null
docker rm -f sim-base sim-vision >/dev/null 2>&1 || true
docker network inspect simnet >/dev/null 2>&1 || docker network create --subnet 10.88.0.0/24 simnet >/dev/null
# the runner writes as root: clean up as root too
docker run --rm -v "$SIM:/s" alterego-sim sh -c 'rm -rf /s/fakeros /s/results; mkdir -p /s/fakeros /s/results; chmod 777 /s/fakeros /s/results'
touch "$SIM/fakeros/events.log" && chmod 666 "$SIM/fakeros/events.log"
printf 'power_alert: False\nis_charging: False\nis_docked: True\nneed_for_charge: False\nbattery_level: 80.0\n' > "$SIM/fakeros/battery.txt"
chmod 666 "$SIM/fakeros/battery.txt"
docker run -d --name sim-base --hostname alterego-base --network simnet --ip 10.88.0.110 \
  -v "$SIM/fakeros:/fakeros" alterego-sim /usr/sbin/sshd -D -e >/dev/null
docker run -d --name sim-vision --hostname alterego-vision --network simnet --ip 10.88.0.111 \
  -p 127.0.0.1:3000:3000 -v "$SIM/fakeros:/fakeros" -v "$SIM/w:/w" alterego-sim \
  su -s /bin/bash alterego-vision -c 'cd /w/src && FAKE_IP=10.88.0.111 exec node webapp.js >> /fakeros/webapp.log 2>&1' >/dev/null
sleep 4
curl -s -m 8 localhost:3000/api/base-ready; echo
