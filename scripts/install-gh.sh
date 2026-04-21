#!/usr/bin/env bash
set -euo pipefail

# Install GitHub CLI on the workspace volume
# so it persists across container restarts.
#
# Layout:
#   /workspace/.local/bin/gh        — gh binary
#   /workspace/.config/gh/          — config, auth tokens (via GH_CONFIG_DIR)
#
# Prerequisites: curl, jq

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

INSTALL_DIR="/workspace/.local/bin"
CONFIG_DIR="/workspace/.config/gh"

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"

# ── Detect architecture ───────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
x86_64) GH_ARCH="amd64" ;;
aarch64 | arm64) GH_ARCH="arm64" ;;
*)
	echo "Unsupported architecture: $ARCH" >&2
	exit 1
	;;
esac

# ── Download & install ────────────────────────────────────────
GH_VERSION="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | sed 's/^v//')"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$TMP_DIR"
curl -fLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"
tar -xzf "gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"

cp "gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" "${INSTALL_DIR}/gh"
chmod +x "${INSTALL_DIR}/gh"

# ── Update .env.sh ────────────────────────────────────────────
ensure_env_line 'export PATH="/workspace/.local/bin:$PATH"'
ensure_env_line "export GH_CONFIG_DIR=$CONFIG_DIR"
ensure_env_line "mkdir -p $CONFIG_DIR"

# ── Verify ────────────────────────────────────────────────────
echo ""
echo "Verifying installation..."
"${INSTALL_DIR}/gh" --version

cat <<EOF

──────────────────────────────────────────
GitHub CLI installed successfully!

  Binary:  $INSTALL_DIR/gh
  Config:  $CONFIG_DIR/

Run:
  source /workspace/.env.sh
  gh auth login
──────────────────────────────────────────
EOF
