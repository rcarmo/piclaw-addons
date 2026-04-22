#!/usr/bin/env bash
set -euo pipefail

# Install ShellCheck on the workspace volume
# so it persists across container restarts AND image rebuilds.
#
# Layout:
#   /workspace/.local/bin/shellcheck  — static binary
#
# Prerequisites: curl, python3 (with built-in lzma module)
# Also adds .sh validator to .pi/validators.json for the diagnostics tool.
# Note: ShellCheck distributes as .tar.xz — container lacks xz,
#       so we use Python's built-in lzma to decompress.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

INSTALL_DIR="/workspace/.local/bin"

mkdir -p "$INSTALL_DIR"

# ── Detect architecture ───────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
x86_64) SC_ARCH="x86_64" ;;
aarch64 | arm64) SC_ARCH="aarch64" ;;
*)
	echo "Unsupported architecture: $ARCH" >&2
	exit 1
	;;
esac

# ── Download & install ────────────────────────────────────────
SC_VERSION="$(curl -fsSL https://api.github.com/repos/koalaman/shellcheck/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+')"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$TMP_DIR"
curl -fLO "https://github.com/koalaman/shellcheck/releases/download/${SC_VERSION}/shellcheck-${SC_VERSION}.linux.${SC_ARCH}.tar.xz"

# Decompress .tar.xz via Python's built-in lzma (no system xz needed)
python3 -c "
import lzma, tarfile, io, sys
with lzma.open('shellcheck-${SC_VERSION}.linux.${SC_ARCH}.tar.xz') as f:
    with tarfile.open(fileobj=io.BytesIO(f.read())) as tar:
        members = [m for m in tar.getmembers() if m.name.endswith('/shellcheck')]
        if not members:
            print('shellcheck binary not found in archive', file=sys.stderr)
            sys.exit(1)
        tar.extract(members[0], '.')
"

cp "shellcheck-${SC_VERSION}/shellcheck" "${INSTALL_DIR}/shellcheck"
chmod +x "${INSTALL_DIR}/shellcheck"

# ── Update .env.sh ────────────────────────────────────────────
ensure_env_line 'export PATH="/workspace/.local/bin:$PATH"'

# ── Ensure .sh validator in validators.json ───────────────────
VALIDATORS_FILE="/workspace/.pi/validators.json"

if [ ! -f "$VALIDATORS_FILE" ]; then
	cat > "$VALIDATORS_FILE" << 'VJSON'
{
  ".sh": [
    {
      "cmd": ["shellcheck", "$FILE"]
    }
  ]
}
VJSON
	echo "Created $VALIDATORS_FILE with .sh validator"
elif grep -q '\.sh' "$VALIDATORS_FILE"; then
	echo ".sh validator already configured in $VALIDATORS_FILE"
else
	python3 << 'PYEOF'
import json
vf = "/workspace/.pi/validators.json"
with open(vf) as f:
    data = json.load(f)
data[".sh"] = [{"cmd": ["shellcheck", "$FILE"]}]
with open(vf, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
	echo "Added .sh validator to existing $VALIDATORS_FILE"
fi

# ── Verify ────────────────────────────────────────────────────
echo ""
echo "Verifying installation..."
"${INSTALL_DIR}/shellcheck" --version

cat <<EOF

──────────────────────────────────────────
ShellCheck installed successfully!

  Binary:  $INSTALL_DIR/shellcheck

Run:
  source /workspace/.env.sh
  shellcheck your-script.sh
──────────────────────────────────────────
EOF
