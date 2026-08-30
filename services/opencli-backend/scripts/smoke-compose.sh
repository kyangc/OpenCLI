#!/bin/sh
set -eu

expected_daemon_version=${1:-}
expected_extension_version=${2:-}
if [ -z "$expected_daemon_version" ] || [ -z "$expected_extension_version" ]; then
  echo "usage: smoke-compose.sh <expected-daemon-version> <expected-extension-version>" >&2
  exit 2
fi

if docker container inspect opencli-backend >/dev/null 2>&1 \
  || docker container inspect opencli-chromium >/dev/null 2>&1; then
  echo "refusing to run Compose smoke while opencli production containers exist" >&2
  exit 1
fi

backend_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
compose_file="$backend_root/compose.yaml"
smoke_tmp_base=${TMPDIR:-/tmp}
smoke_tmp_base=${smoke_tmp_base%/}
smoke_runtime=$(mktemp -d "$smoke_tmp_base/opencli-backend-smoke.XXXXXX")
smoke_env="$smoke_runtime/smoke.env"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    docker compose --env-file "$smoke_env" -f "$compose_file" logs --no-color || true
  fi
  docker exec --user 0 opencli-backend \
    chmod -R a+rwX /data /home/node/.opencli || true
  docker compose --env-file "$smoke_env" -f "$compose_file" \
    down --volumes --remove-orphans || true
  case "$smoke_runtime" in
    "$smoke_tmp_base"/opencli-backend-smoke.*) rm -rf "$smoke_runtime" ;;
    *) echo "refusing to remove unexpected smoke directory: $smoke_runtime" >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$smoke_runtime/browser-config" "$smoke_runtime/data" "$smoke_runtime/opencli-state"
chmod 0777 "$smoke_runtime/data" "$smoke_runtime/opencli-state"

cat > "$smoke_env" <<EOF
BIND_ADDRESS=127.0.0.1
GUI_PORT=23001
API_PORT=28080
GUI_USER=opencli-smoke
PUID=$(id -u)
PGID=$(id -g)
TZ=UTC
OPENCLI_RUNTIME_ROOT=$smoke_runtime
OPENCLI_AUTO_ALLOW_READS=false
OPENCLI_SESSION_CHECK_SITES=disabled
EOF

(
  cd "$smoke_runtime"
  "$backend_root/scripts/generate-secrets.sh"
)

docker compose --env-file "$smoke_env" -f "$compose_file" config --quiet
docker compose --env-file "$smoke_env" -f "$compose_file" up -d --no-build
node "$backend_root/scripts/smoke-deployment.mjs" \
  --base-url http://127.0.0.1:28080 \
  --expected-daemon-version "$expected_daemon_version" \
  --expected-extension-version "$expected_extension_version" \
  --timeout-seconds 180 \
  --poll-interval-ms 1000
