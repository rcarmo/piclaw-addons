#!/bin/bash
# install-browser-relay.sh — Container-side setup for WSL2 browser relay
#
# Sets up BROWSER= env var so that az login, jupyter, etc. can open URLs
# in the Windows host browser via a relay running on the WSL2 host.
#
# Architecture:
#   Container (BROWSER=browser-relay) → HTTP → WSL2 host (wsl-browser-relay.py) → wslview → Windows browser
#   Windows browser → OAuth redirect → localhost:PORT → Container (az callback)
#
# Prerequisites:
#   - network_mode: host (container shares WSL2 network)
#   - WSL2 mirrored mode (localhost is shared with Windows)
#   - wsl-browser-relay.py running on WSL2 host (see host-side setup below)
#
# Host-side setup (run once on WSL2, NOT in the container):
#   # Install wslu if not present
#   sudo apt install wslu
#
#   # Copy files from container workspace
#   cp /path/to/workspace/.local/bin/wsl-browser-relay.py ~/.local/bin/
#   cp /path/to/workspace/.local/bin/wsl-browser-relay.service ~/.config/systemd/user/
#
#   # Enable as systemd user service
#   systemctl --user daemon-reload
#   systemctl --user enable --now wsl-browser-relay
#
#   # Or run manually:
#   python3 ~/.local/bin/wsl-browser-relay.py

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_SCRIPT="${SCRIPT_DIR}/browser-relay"
PORT="${BROWSER_RELAY_PORT:-9222}"
HOST="${BROWSER_RELAY_HOST:-localhost}"
ENV_FILE="/workspace/.env.sh"

# 1. Make relay script executable
chmod +x "$RELAY_SCRIPT"

# 2. Set env vars via piclaw's env tool if available, otherwise write .env.sh directly
if command -v piclaw >/dev/null 2>&1; then
    # piclaw env tool sets process.env immediately + persists to .env.sh
    echo "Setting env vars via piclaw env tool..."
    piclaw env set BROWSER "$RELAY_SCRIPT" 2>/dev/null || true
    piclaw env set BROWSER_RELAY_PORT "$PORT" 2>/dev/null || true
    piclaw env set BROWSER_RELAY_HOST "$HOST" 2>/dev/null || true
else
    # Fallback: write .env.sh directly (requires restart to take effect)
    [ -f "$ENV_FILE" ] || { echo "# Workspace environment" > "$ENV_FILE"; echo "Created $ENV_FILE"; }
    if grep -qE '^\s*(export\s+)?BROWSER=' "$ENV_FILE" 2>/dev/null; then
        echo "BROWSER already set in $ENV_FILE — skipping"
    else
        echo "" >> "$ENV_FILE"
        echo "# Browser relay for WSL2 → Windows browser integration" >> "$ENV_FILE"
        echo "export BROWSER=\"$RELAY_SCRIPT\"" >> "$ENV_FILE"
        echo "export BROWSER_RELAY_PORT=\"$PORT\"" >> "$ENV_FILE"
        echo "export BROWSER_RELAY_HOST=\"$HOST\"" >> "$ENV_FILE"
        echo "Added BROWSER=$RELAY_SCRIPT to $ENV_FILE"
        echo "Note: restart piclaw or run 'source $ENV_FILE' for changes to take effect"
    fi
fi

# 3. Export for current shell session
export BROWSER="$RELAY_SCRIPT"
export BROWSER_RELAY_PORT="$PORT"
export BROWSER_RELAY_HOST="$HOST"

# 4. Verify
echo ""
echo "=== Container-side setup complete ==="
echo "  BROWSER=$BROWSER"
echo "  BROWSER_RELAY_PORT=$BROWSER_RELAY_PORT"
echo "  BROWSER_RELAY_HOST=$BROWSER_RELAY_HOST"

# 5. Test relay connectivity
echo ""
echo "Testing relay connectivity..."
if curl -sf --max-time 2 --get --data-urlencode "url=http://test" \
  "http://${HOST}:${PORT}/open" >/dev/null 2>&1; then
    echo "  ✓ Relay is reachable"
else
    echo "  ✗ Relay not reachable — start wsl-browser-relay.py on the WSL2 host first"
fi

echo ""
echo "=== Host-side setup (if not done) ==="
echo "  On your WSL2 host (not in the container), run:"
echo ""
echo "    sudo apt install wslu   # if not installed"
echo "    python3 ${SCRIPT_DIR}/wsl-browser-relay.py"
echo ""
echo "  Or install as a systemd user service:"
echo ""
echo "    mkdir -p ~/.config/systemd/user ~/.local/bin"
echo "    cp ${SCRIPT_DIR}/wsl-browser-relay.py ~/.local/bin/"
echo "    cp ${SCRIPT_DIR}/wsl-browser-relay.service ~/.config/systemd/user/"
echo "    systemctl --user daemon-reload"
echo "    systemctl --user enable --now wsl-browser-relay"
