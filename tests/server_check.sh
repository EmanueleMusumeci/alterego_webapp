#!/bin/sh
# Runs inside node:10-alpine on droplet-midmain: start the server in isolated test mode
# (base IP 127.0.0.1) and time GET /api/base-ready. Case 1: no SSH key. Case 2: a key exists
# and port 22 accepts TCP but never speaks SSH (a base that hangs while rebooting).
set -eu
[ -d node_modules/ssh2 ] || npm ci --production --no-audit >/dev/null 2>&1
# busybox hostname has no -I; the server only needs one address to start.
mkdir -p /tmp/bin && printf '#!/bin/sh\necho 10.0.0.11\n' > /tmp/bin/hostname && chmod +x /tmp/bin/hostname
PATH=/tmp/bin:$PATH WEBAPP_TEST_MODE=1 PORT=3999 HOST=127.0.0.1 node src/webapp.js >/tmp/server.log 2>&1 &

probe() {
node -e '
const http = require("http");
const deadline = Date.now() + 20000;
(function probe() {
  const t = Date.now();
  http.get("http://127.0.0.1:3999/api/base-ready", r => {
    let b = ""; r.on("data", d => b += d);
    r.on("end", () => {
      const ms = Date.now() - t;
      console.log("GET /api/base-ready (" + process.argv[1] + ") ->", b, ms + " ms");
      process.exit(b === "{\"ready\":false}" && ms < 7000 ? 0 : 1);
    });
  }).on("error", () => Date.now() < deadline ? setTimeout(probe, 500) : process.exit(2));
})();' "$1" || { cat /tmp/server.log; exit 1; }
}

probe "no key"

# Settings store, status and recent log (no robot needed).
node -e '
const http = require("http");
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 3999, path, method, headers: { "Content-Type": "application/json" } }, r => {
      let b = ""; r.on("data", d => b += d); r.on("end", () => resolve({ code: r.statusCode, body: b }));
    });
    req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
(async () => {
  const bad1 = await call("POST", "/api/settings", { headMotion: "no" });
  const bad2 = await call("POST", "/api/settings", { rm: true });
  const ok = await call("POST", "/api/settings", { gestures: false });
  const get = JSON.parse((await call("GET", "/api/settings")).body);
  const status = JSON.parse((await call("GET", "/api/status")).body);
  const log = JSON.parse((await call("GET", "/api/startup-log/recent")).body);
  const pass = bad1.code === 400 && bad2.code === 400 && ok.code === 200 && get.gestures === false &&
    get.headMotion === true && get.autoShutdownOnDock === true && status.base.reachable === false &&
    Array.isArray(status.backends) && log.some(e => e.event === "settings.changed");
  console.log("settings/status/log:", pass ? "ok" : "FAIL", JSON.stringify({ bad1: bad1.code, bad2: bad2.code, get, base: status.base }));
  process.exit(pass ? 0 : 1);
})();' || { cat /tmp/server.log; exit 1; }
mkdir -p "/home/$(whoami)/.ssh"
node -e 'const { generateKeyPairSync } = require("crypto");
process.stdout.write(generateKeyPairSync("rsa", { modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey);' \
  > "/home/$(whoami)/.ssh/id_rsa"
node -e 'require("net").createServer(() => {}).listen(22, "127.0.0.1")' &
sleep 1
probe "silent port 22"
echo "server check ok"
