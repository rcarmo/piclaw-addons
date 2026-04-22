#!/usr/bin/env bash
set -euo pipefail

# Install tflint (Terraform linter) on the workspace volume
# so it persists across container restarts AND image rebuilds.
#
# tflint catches cloud-provider-specific errors that terraform validate misses:
#   - Invalid instance types, deprecated resources, best practice violations
#   - Pluggable rule sets for AWS, Azure, GCP
#
# Layout:
#   /workspace/.local/bin/tflint  — tflint binary
#
# Prerequisites: curl, python3 (with built-in zipfile module)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

INSTALL_DIR="/workspace/.local/bin"

mkdir -p "$INSTALL_DIR"

# ── Detect architecture ───────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
x86_64) TFL_ARCH="amd64" ;;
aarch64 | arm64) TFL_ARCH="arm64" ;;
*)
	echo "Unsupported architecture: $ARCH" >&2
	exit 1
	;;
esac

# ── Download & install ────────────────────────────────────────
TFL_VERSION="$(curl -fsSL https://api.github.com/repos/terraform-linters/tflint/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+')"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$TMP_DIR"
echo "Downloading tflint ${TFL_VERSION} for linux_${TFL_ARCH}..."
curl -fLO "https://github.com/terraform-linters/tflint/releases/download/${TFL_VERSION}/tflint_linux_${TFL_ARCH}.zip"

# Extract via Python zipfile (no system unzip dependency)
python3 -c "
import zipfile
with zipfile.ZipFile('tflint_linux_${TFL_ARCH}.zip') as z:
    z.extract('tflint', '.')
"

cp tflint "${INSTALL_DIR}/tflint"
chmod +x "${INSTALL_DIR}/tflint"

# ── Update .env.sh ────────────────────────────────────────────
ensure_env_line 'export PATH="/workspace/.local/bin:$PATH"'

# ── Verify ────────────────────────────────────────────────────
echo ""
echo "Verifying installation..."
"${INSTALL_DIR}/tflint" --version

cat <<EOF

──────────────────────────────────────────
tflint installed successfully!

  Binary:  $INSTALL_DIR/tflint

To enable cloud provider rules:
  tflint --init  (in a directory with .tflint.hcl config)

Run:
  source /workspace/.env.sh
  tflint
──────────────────────────────────────────
EOF
