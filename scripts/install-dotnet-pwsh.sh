#!/usr/bin/env bash
set -euo pipefail

# Install .NET SDK 10 and PowerShell (pwsh) on the workspace volume
# so they persist across container restarts.
#
# Layout:
#   /workspace/.local/dotnet/           — .NET SDK installation
#   /workspace/.local/bin/dotnet        — symlink to dotnet binary
#   /workspace/.local/bin/pwsh          — symlink to pwsh binary
#   /workspace/.config/dotnet/          — NuGet cache, user config
#
# Uses invariant globalization mode (no libicu dependency).
#
# Prerequisites: curl

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

BIN_DIR="/workspace/.local/bin"
DOTNET_INSTALL_DIR="/workspace/.local/dotnet"
DOTNET_CONFIG_DIR="/workspace/.config/dotnet"
DOTNET_CHANNEL="10.0"

mkdir -p "$BIN_DIR" "$DOTNET_INSTALL_DIR" "$DOTNET_CONFIG_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
	x86_64)  DOTNET_ARCH="x64" ;;
	aarch64) DOTNET_ARCH="arm64" ;;
	*)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# ── Install .NET SDK ──────────────────────────────────────────
if [ -x "$DOTNET_INSTALL_DIR/dotnet" ]; then
	CURRENT_VERSION=$("$DOTNET_INSTALL_DIR/dotnet" --version 2>/dev/null || echo "unknown")
	echo ".NET SDK already installed: $CURRENT_VERSION"
	echo "To force reinstall, remove $DOTNET_INSTALL_DIR and re-run."
else
	echo "Installing .NET SDK $DOTNET_CHANNEL ($DOTNET_ARCH)..."
	curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- \
		--channel "$DOTNET_CHANNEL" \
		--install-dir "$DOTNET_INSTALL_DIR" \
		--architecture "$DOTNET_ARCH"
	echo ".NET SDK installed: $("$DOTNET_INSTALL_DIR/dotnet" --version)"
fi

# Symlink dotnet to bin dir
ln -sf "$DOTNET_INSTALL_DIR/dotnet" "$BIN_DIR/dotnet"

# ── Install PowerShell (pwsh) as .NET global tool ─────────────
export DOTNET_ROOT="$DOTNET_INSTALL_DIR"
export PATH="$DOTNET_INSTALL_DIR:$BIN_DIR:$PATH"
export DOTNET_CLI_HOME="$DOTNET_CONFIG_DIR"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

if command -v "$BIN_DIR/pwsh" &>/dev/null; then
	CURRENT_PWSH=$("$BIN_DIR/pwsh" --version 2>/dev/null || echo "unknown")
	echo "PowerShell already installed: $CURRENT_PWSH"
	echo "To update: dotnet tool update --global powershell"
else
	echo "Installing PowerShell (pwsh) as .NET global tool..."
	"$DOTNET_INSTALL_DIR/dotnet" tool install --tool-path "$BIN_DIR" powershell
	echo "PowerShell installed: $("$BIN_DIR/pwsh" --version)"
fi

# ── Persist environment in .env.sh ────────────────────────────
ensure_env_line "export DOTNET_ROOT=$DOTNET_INSTALL_DIR"
ensure_env_line "export DOTNET_CLI_HOME=$DOTNET_CONFIG_DIR"
ensure_env_line "export DOTNET_CLI_TELEMETRY_OPTOUT=1"
ensure_env_line "export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1"
ensure_env_line "mkdir -p $DOTNET_CONFIG_DIR"

echo ""
echo "Done ✅"
export DOTNET_ROOT="$DOTNET_INSTALL_DIR"
echo "  dotnet: $(dotnet --version)"
echo "  pwsh:   $(pwsh --version)"
echo ""
echo "Environment persisted in /workspace/.env.sh"
echo "Use /restart or open a new terminal to pick up PATH changes."
