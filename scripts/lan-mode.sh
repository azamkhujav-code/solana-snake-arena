#!/usr/bin/env bash
#
# Points the stack at this machine's LAN address so other devices on the same
# network can play.
#
# Three things have to change, and missing any one of them fails differently:
#
#   - `NEXT_PUBLIC_*` are baked into the browser bundle at build time, so the
#     web app must be *rebuilt*, not just restarted. Skip this and the other
#     device's browser asks its own machine for the API.
#   - `ADVERTISE_URL` is what the matchmaker hands out as the game socket. Left
#     as localhost, the room list loads and the match never connects.
#   - `CORS_ORIGINS` must include the new origin or every API call is blocked.
#
# Run again whenever the IP changes — DHCP reassigns it, and every one of the
# symptoms above returns looking like a different bug.
#
# Usage: scripts/lan-mode.sh            # detect and apply this machine's IP
#        scripts/lan-mode.sh localhost  # go back to local-only
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

if [ "${1:-}" = "localhost" ]; then
  HOST_ADDR=localhost
else
  HOST_ADDR="${1:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
fi

if [ -z "$HOST_ADDR" ]; then
  echo "Could not detect a LAN address. Pass one explicitly:" >&2
  echo "  scripts/lan-mode.sh 192.168.1.42" >&2
  exit 1
fi

echo "Pointing the stack at: $HOST_ADDR"

python3 - "$ENV_FILE" "$HOST_ADDR" <<'PY'
import re, sys
path, host = sys.argv[1], sys.argv[2]
env = open(path).read()

def put(key, value):
    global env
    line = f"{key}={value}"
    if re.search(rf"^{key}=.*$", env, re.M):
        env = re.sub(rf"^{key}=.*$", line, env, flags=re.M)
    else:
        env += f"\n{line}\n"

put("NEXT_PUBLIC_APP_URL", f"http://{host}:3100")
put("NEXT_PUBLIC_GATEWAY_URL", f"http://{host}:4200")
put("NEXT_PUBLIC_MATCHMAKER_URL", f"http://{host}:4202")
put("ADVERTISE_URL", f"http://{host}:4201")

# Keep localhost working alongside the LAN address: the machine running the
# stack usually browses it as localhost, and losing that would be a surprise.
origins = [f"http://{host}:3100", "http://localhost:3100", "http://127.0.0.1:3100"]
put("CORS_ORIGINS", ",".join(dict.fromkeys(origins)))

open(path, "w").write(env)
PY

echo "Rebuilding the web app (NEXT_PUBLIC_* are compiled in)..."
(cd "$ROOT" && pnpm --filter @arena/web build >/dev/null)

cat <<EOF

Done. Restart the services, then open:

  http://$HOST_ADDR:3100

Other devices need to be on the same network, and macOS may prompt to allow
incoming connections the first time.
EOF
