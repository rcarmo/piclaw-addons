#!/usr/bin/env bash
set -euo pipefail

# Install Biome (linter + formatter) on the workspace volume
# so it persists across container restarts AND image rebuilds.
#
# Biome is a single static Rust binary that handles:
#   - JSON + JSONC validation
#   - JavaScript/TypeScript linting
#   - CSS linting
#   - Code formatting (replaces prettier)
#
# Auto-adds biome validators to .pi/validators.json for:
#   .jsonc, .css (new coverage), .ts, .tsx, .js, .jsx, .json (additional validator)
#
# Layout:
#   /workspace/.local/bin/biome  — biome binary
#
# Prerequisites: curl

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

INSTALL_DIR="/workspace/.local/bin"

mkdir -p "$INSTALL_DIR"

# ── Detect architecture ───────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
x86_64) BIOME_ARCH="linux-x64" ;;
aarch64 | arm64) BIOME_ARCH="linux-arm64" ;;
*)
	echo "Unsupported architecture: $ARCH" >&2
	exit 1
	;;
esac

# ── Download & install ────────────────────────────────────────
BIOME_TAG="$(curl -fsSL https://api.github.com/repos/biomejs/biome/releases/latest | grep -oP '"tag_name":\s*"\K[^"]+')"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$TMP_DIR"
echo "Downloading Biome ${BIOME_TAG} for ${BIOME_ARCH}..."
# URL-encode the @ in the tag name
BIOME_TAG_ENCODED="$(echo "$BIOME_TAG" | sed 's/@/%40/g')"
curl -fL "https://github.com/biomejs/biome/releases/download/${BIOME_TAG_ENCODED}/biome-${BIOME_ARCH}" -o biome
chmod +x biome
cp biome "${INSTALL_DIR}/biome"

# ── Update .env.sh ────────────────────────────────────────────
ensure_env_line 'export PATH="/workspace/.local/bin:$PATH"'

# ── Ensure biome validators in validators.json ─────────────
VALIDATORS_FILE="/workspace/.pi/validators.json"
# Biome covers: .jsonc and .css (not covered by built-ins)
# Also adds as additional validator for .ts/.tsx/.js/.jsx/.json
BIOME_EXTENSIONS='.jsonc .css .ts .tsx .js .jsx .json'

if [ ! -f "$VALIDATORS_FILE" ]; then
	python3 << 'PYEOF'
import json
exts = [".jsonc", ".css", ".ts", ".tsx", ".js", ".jsx", ".json"]
data = {}
for ext in exts:
    data[ext] = [{"cmd": ["biome", "check", "$FILE"]}]
with open("/workspace/.pi/validators.json", "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
	echo "Created $VALIDATORS_FILE with biome validators"
else
	python3 << 'PYEOF'
import json
vf = "/workspace/.pi/validators.json"
with open(vf) as f:
    data = json.load(f)
biome_entry = {"cmd": ["biome", "check", "$FILE"]}
added = []
for ext in [".jsonc", ".css", ".ts", ".tsx", ".js", ".jsx", ".json"]:
    existing = data.get(ext, [])
    has_biome = any("biome" in v.get("cmd", []) for v in existing)
    if not has_biome:
        existing.append(biome_entry)
        data[ext] = existing
        added.append(ext)
if added:
    with open(vf, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"Added biome validator for: {', '.join(added)}")
else:
    print("Biome validators already configured in validators.json")
PYEOF
fi

# ── Verify ────────────────────────────────────────────────────
echo ""
echo "Verifying installation..."
"${INSTALL_DIR}/biome" --version

cat <<EOF

──────────────────────────────────────────
Biome installed successfully!

  Binary:  $INSTALL_DIR/biome

Biome replaces multiple tools:
  biome check file.ts       # lint JS/TS
  biome check file.json     # validate JSON
  biome check file.jsonc    # validate JSONC
  biome check file.css      # lint CSS
  biome format file.ts      # format code
  biome lint file.ts        # lint only

Run:
  source /workspace/.env.sh
  biome --help
──────────────────────────────────────────
EOF
