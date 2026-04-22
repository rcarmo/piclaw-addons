#!/usr/bin/env bash
set -euo pipefail

# Install Terraform on the workspace volume
# so it persists across container restarts AND image rebuilds.
#
# Layout:
#   /workspace/.local/bin/terraform   — terraform binary
#   /workspace/.terraform.d/plugin-cache/ — provider plugin cache
#
# Prerequisites: curl, python3 (with built-in zipfile module)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

INSTALL_DIR="/workspace/.local/bin"
PLUGIN_CACHE="/workspace/.terraform.d/plugin-cache"

mkdir -p "$INSTALL_DIR" "$PLUGIN_CACHE"

# ── Detect architecture ───────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
x86_64) TF_ARCH="amd64" ;;
aarch64 | arm64) TF_ARCH="arm64" ;;
*)
	echo "Unsupported architecture: $ARCH" >&2
	exit 1
	;;
esac

# ── Download & install ────────────────────────────────────────
TF_VERSION="$(curl -fsSL https://releases.hashicorp.com/terraform/ | grep -oP 'terraform/\K[0-9]+\.[0-9]+\.[0-9]+' | head -1)"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$TMP_DIR"
echo "Downloading Terraform ${TF_VERSION} for linux_${TF_ARCH}..."
curl -fLO "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_${TF_ARCH}.zip"

# Extract via Python zipfile (no system unzip dependency)
python3 -c "
import zipfile
with zipfile.ZipFile('terraform_${TF_VERSION}_linux_${TF_ARCH}.zip') as z:
    z.extract('terraform', '.')
"

cp terraform "${INSTALL_DIR}/terraform"
chmod +x "${INSTALL_DIR}/terraform"

# ── Update .env.sh ────────────────────────────────────────────
ensure_env_line 'export PATH="/workspace/.local/bin:$PATH"'
ensure_env_line "export TF_PLUGIN_CACHE_DIR=$PLUGIN_CACHE"
ensure_env_line "mkdir -p $PLUGIN_CACHE"

# ── Verify ────────────────────────────────────────────────────
echo ""
echo "Verifying installation..."
"${INSTALL_DIR}/terraform" --version

cat <<EOF

──────────────────────────────────────────
Terraform installed successfully!

  Binary:       $INSTALL_DIR/terraform
  Plugin cache: $PLUGIN_CACHE/

Run:
  source /workspace/.env.sh
  terraform --version
──────────────────────────────────────────
EOF
