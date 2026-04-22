#!/usr/bin/env bash
set -euo pipefail

# Add Bicep (.bicep) validator entry to .pi/validators.json
#
# Uses `az bicep build` to validate Bicep files.
# No tool installation — requires az cli already installed (install-az.sh).
#
# Prerequisites: az cli with bicep, python3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

BIN_DIR="/workspace/.local/bin"

# ── Check az is available ─────────────────────────────────────
if ! command -v "$BIN_DIR/az" &>/dev/null; then
	echo "Error: az not found at $BIN_DIR/az"
	echo "Run install-az.sh first."
	exit 1
fi

# Verify bicep is available
if ! "$BIN_DIR/az" bicep version &>/dev/null; then
	echo "Error: az bicep not available. Run: az bicep install"
	exit 1
fi

echo "az bicep version: $("$BIN_DIR/az" bicep version 2>&1)"

# ── Ensure .bicep validator in validators.json ────────────────
VALIDATORS_FILE="/workspace/.pi/validators.json"

if [ ! -f "$VALIDATORS_FILE" ]; then
	cat > "$VALIDATORS_FILE" << 'VJSON'
{
  ".bicep": [
    {
      "cmd": ["az", "bicep", "build", "--file", "$FILE", "--stdout"],
      "env": { "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT": "1" }
    }
  ]
}
VJSON
	echo "Created $VALIDATORS_FILE with .bicep validator"
elif grep -q '\.bicep' "$VALIDATORS_FILE"; then
	echo ".bicep validator already configured in $VALIDATORS_FILE"
else
	python3 << 'PYEOF'
import json
vf = "/workspace/.pi/validators.json"
with open(vf) as f:
    data = json.load(f)
data[".bicep"] = [{
    "cmd": ["az", "bicep", "build", "--file", "$FILE", "--stdout"],
    "env": {"DOTNET_SYSTEM_GLOBALIZATION_INVARIANT": "1"}
}]
with open(vf, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
	echo "Added .bicep validator to existing $VALIDATORS_FILE"
fi

echo ""
echo "Done ✅"
echo "The diagnostics tool now validates .bicep files."
echo "Use /restart to reload the extension."
