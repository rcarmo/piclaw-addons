#!/usr/bin/env bash
set -euo pipefail

# Install uv (Python package manager) on the workspace volume
# so it persists across container restarts AND image rebuilds.
#
# Layout:
#   /workspace/.local/bin/uv   — uv binary
#   /workspace/.local/bin/uvx  — uvx convenience wrapper
#
# Prerequisites: curl

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

INSTALL_DIR="/workspace/.local/bin"

mkdir -p "$INSTALL_DIR"

# ── Download & install ────────────────────────────────────────
export UV_INSTALL_DIR="$INSTALL_DIR"
curl -fsSL https://astral.sh/uv/install.sh | sh

# ── Update .env.sh ────────────────────────────────────────────
ensure_env_line 'export PATH="/workspace/.local/bin:$PATH"'

# ── Verify ────────────────────────────────────────────────────
echo ""
echo "Verifying installation..."
"${INSTALL_DIR}/uv" --version

cat <<EOF

──────────────────────────────────────────
uv installed successfully!

  Binary:  $INSTALL_DIR/uv
  Runner:  $INSTALL_DIR/uvx

Examples:
  source /workspace/.env.sh
  uv tool install ruff        # install Python tools
  uv tool install yamllint
  uvx httpie GET example.com  # run one-off tools
──────────────────────────────────────────
EOF
