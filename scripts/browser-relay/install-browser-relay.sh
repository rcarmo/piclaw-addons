#!/usr/bin/env bash
# install-browser-relay.sh — configure container-side browser relay support.
#
# Sets BROWSER to the local browser-relay shim so tools like az login,
# jupyter, and Python webbrowser.open() can open URLs in the Windows browser
# via a small relay running on the WSL2 host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_SCRIPT="${SCRIPT_DIR}/browser-relay"
LIB_ENV_HELPER="${SCRIPT_DIR}/../lib/env-helper.sh"
ENV_FILE="/workspace/.env.sh"
PORT="${BROWSER_RELAY_PORT:-9222}"
HOST="${BROWSER_RELAY_HOST:-localhost}"

chmod +x "$RELAY_SCRIPT"

persist_with_piclaw_env() {
  command -v piclaw >/dev/null 2>&1 || return 1
  echo "Setting workspace env via piclaw env..."
  piclaw env set BROWSER "$RELAY_SCRIPT" || return 1
  piclaw env set BROWSER_RELAY_PORT "$PORT" || return 1
  piclaw env set BROWSER_RELAY_HOST "$HOST" || return 1
}

persist_with_env_file() {
  if [[ -f "$LIB_ENV_HELPER" ]]; then
    # shellcheck disable=SC1090
    source "$LIB_ENV_HELPER"
    ensure_env_line ""
    ensure_env_line "# Browser relay for WSL2 → Windows browser integration"
    ensure_env_line "export BROWSER=$(printf '%q' "$RELAY_SCRIPT")"
    ensure_env_line "export BROWSER_RELAY_PORT=$(printf '%q' "$PORT")"
    ensure_env_line "export BROWSER_RELAY_HOST=$(printf '%q' "$HOST")"
  else
    touch "$ENV_FILE"
    {
      printf '\n# Browser relay for WSL2 → Windows browser integration\n'
      printf 'export BROWSER=%q\n' "$RELAY_SCRIPT"
      printf 'export BROWSER_RELAY_PORT=%q\n' "$PORT"
      printf 'export BROWSER_RELAY_HOST=%q\n' "$HOST"
    } >> "$ENV_FILE"
  fi
  echo "Updated $ENV_FILE"
  echo "Restart piclaw or source $ENV_FILE if the current shell needs the new values immediately."
}

persist_with_piclaw_env || persist_with_env_file

export BROWSER="$RELAY_SCRIPT"
export BROWSER_RELAY_PORT="$PORT"
export BROWSER_RELAY_HOST="$HOST"

echo
echo "=== Container-side setup complete ==="
echo "  BROWSER=$BROWSER"
echo "  BROWSER_RELAY_PORT=$BROWSER_RELAY_PORT"
echo "  BROWSER_RELAY_HOST=$BROWSER_RELAY_HOST"

echo
echo "Testing relay connectivity..."
if curl -sf --max-time 2 --get --data-urlencode "url=http://test" \
  "http://${HOST}:${PORT}/open" >/dev/null 2>&1; then
  echo "  ✓ Relay is reachable"
else
  echo "  ✗ Relay not reachable — start wsl-browser-relay.py on the WSL2 host first"
fi

echo
echo "=== Host-side setup (run on the WSL2 host, not in the container) ==="
echo "  sudo apt install wslu"
echo "  mkdir -p ~/.config/systemd/user ~/.local/bin"
echo "  cp ${SCRIPT_DIR}/wsl-browser-relay.py ~/.local/bin/"
echo "  cp ${SCRIPT_DIR}/wsl-browser-relay.service ~/.config/systemd/user/"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now wsl-browser-relay"
echo
echo "Or run it manually:"
echo "  python3 ${SCRIPT_DIR}/wsl-browser-relay.py"
