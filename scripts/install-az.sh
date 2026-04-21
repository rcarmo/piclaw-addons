#!/usr/bin/env bash
set -euo pipefail

# Install Azure CLI (via uv tool) on the workspace volume
# so it persists across container restarts.
#
# Layout:
#   /workspace/.local/bin/uv            — uv package manager (installed if missing)
#   /workspace/.local/bin/az            — az binary (managed by uv tool)
#   /workspace/.local/uv-tools/        — uv-managed tool environments
#   /workspace/.config/azure/           — config, tokens, profiles (via AZURE_CONFIG_DIR)
#
# Prerequisites: python3, curl

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

BIN_DIR="/workspace/.local/bin"
TOOL_DIR="/workspace/.local/uv-tools"
CONFIG_DIR="/workspace/.config/azure"

mkdir -p "$BIN_DIR" "$CONFIG_DIR"

export UV_TOOL_BIN_DIR="$BIN_DIR"
export UV_TOOL_DIR="$TOOL_DIR"
export UV_LINK_MODE=copy

# ── Install uv if missing ─────────────────────────────────────
if ! command -v "$BIN_DIR/uv" &>/dev/null; then
	echo "Installing uv..."
	curl -fsSL https://astral.sh/uv/install.sh \
		| env CARGO_HOME=/workspace/.local UV_INSTALL_DIR="$BIN_DIR" sh 2>&1
fi
export PATH="$BIN_DIR:$PATH"

# ── Install or upgrade azure-cli ──────────────────────────────
if uv tool list 2>/dev/null | grep -q "^azure-cli"; then
	echo "Upgrading azure-cli..."
	uv tool upgrade azure-cli --prerelease=allow 2>&1 | tail -5
else
	echo "Installing azure-cli (this may take a minute)..."
	uv tool install azure-cli --prerelease=allow 2>&1 | tail -5
fi

# ── Migrate existing config (copy only, never delete) ─────────
if [ -d "${HOME}/.azure" ] && [ ! -L "${HOME}/.azure" ]; then
	echo "Copying existing ~/.azure contents to $CONFIG_DIR..."
	cp -a "${HOME}/.azure"/* "$CONFIG_DIR/" 2>/dev/null || true
fi

# ── Update .env.sh ────────────────────────────────────────────
ensure_env_line 'export PATH="/workspace/.local/bin:$PATH"'
ensure_env_line "export AZURE_CONFIG_DIR=$CONFIG_DIR"
ensure_env_line "mkdir -p $CONFIG_DIR"

# ── Verify ────────────────────────────────────────────────────
export AZURE_CONFIG_DIR="$CONFIG_DIR"
echo ""
echo "Verifying installation..."
"$BIN_DIR/az" version -o table 2>&1

cat <<EOF

──────────────────────────────────────────
Azure CLI installed successfully!

  Binary:  $BIN_DIR/az
  Config:  $CONFIG_DIR/

Run:
  source /workspace/.env.sh
  az login
──────────────────────────────────────────
EOF
