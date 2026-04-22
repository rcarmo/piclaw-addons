#!/usr/bin/env bash
set -euo pipefail

# Install PSScriptAnalyzer module to workspace volume
# so it persists across container restarts.
#
# Layout:
#   /workspace/.local/pwsh-modules/PSScriptAnalyzer/  — module files
#
# Requires: pwsh (install via install-pwsh.sh or install-dotnet-pwsh.sh first)
#
# Prerequisites: pwsh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

BIN_DIR="/workspace/.local/bin"
MODULES_DIR="/workspace/.local/pwsh-modules"

# ── Check pwsh is available ───────────────────────────────────
if ! command -v "$BIN_DIR/pwsh" &>/dev/null; then
	echo "Error: pwsh not found at $BIN_DIR/pwsh"
	echo "Run install-pwsh.sh or install-dotnet-pwsh.sh first."
	exit 1
fi

export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
export DOTNET_ROOT="${DOTNET_ROOT:-/workspace/.local/dotnet}"
export PATH="$BIN_DIR:$PATH"

mkdir -p "$MODULES_DIR"

# ── Install PSScriptAnalyzer ──────────────────────────────────
if [ -d "$MODULES_DIR/PSScriptAnalyzer" ]; then
	CURRENT_VERSION=$(ls "$MODULES_DIR/PSScriptAnalyzer/" | head -1)
	echo "PSScriptAnalyzer already installed: $CURRENT_VERSION"
	echo "To update, remove $MODULES_DIR/PSScriptAnalyzer and re-run."
else
	echo "Installing PSScriptAnalyzer..."
	pwsh -NoProfile -Command "Save-PSResource -Name PSScriptAnalyzer -Path '$MODULES_DIR' -TrustRepository"
	VERSION=$(ls "$MODULES_DIR/PSScriptAnalyzer/" | head -1)
	echo "PSScriptAnalyzer installed: $VERSION"
fi

# ── Create validators.json if not present ─────────────────────
VALIDATORS_FILE="/workspace/.pi/validators.json"
if [ ! -f "$VALIDATORS_FILE" ]; then
	cat > "$VALIDATORS_FILE" << 'VJSON'
{
  ".ps1": [
    {
      "cmd": ["pwsh", "-NoProfile", "-Command", "$env:PSModulePath='/workspace/.local/pwsh-modules'; Invoke-ScriptAnalyzer -Path $FILE -Severity Error,Warning | Format-List RuleName,Severity,Line,Message"],
      "env": { "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT": "1" }
    }
  ]
}
VJSON
	echo "Created $VALIDATORS_FILE with .ps1 validator"
else
	echo "Validators config already exists at $VALIDATORS_FILE"
	echo "Add .ps1 entry manually if needed."
fi

# ── Persist environment in .env.sh ────────────────────────────
ensure_env_line "export PSModulePath=$MODULES_DIR"

echo ""
echo "Done ✅"
echo "  Module: PSScriptAnalyzer $(ls "$MODULES_DIR/PSScriptAnalyzer/")"
echo "  Path:   $MODULES_DIR"
echo ""
echo "The diagnostics tool now validates .ps1 files."
echo "Use /restart to reload the extension."
