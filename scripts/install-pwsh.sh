#!/usr/bin/env bash
set -euo pipefail

# Install PowerShell (pwsh) standalone on the workspace volume
# so it persists across container restarts.
#
# Downloads the self-contained tar.gz from GitHub (includes .NET runtime).
# No .NET SDK required.
#
# Layout:
#   /workspace/.local/pwsh/             — PowerShell installation
#   /workspace/.local/bin/pwsh          — symlink to pwsh binary
#
# Uses invariant globalization (no libicu dependency).
#
# Prerequisites: curl

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/env-helper.sh"

BIN_DIR="/workspace/.local/bin"
PWSH_INSTALL_DIR="/workspace/.local/pwsh"

mkdir -p "$BIN_DIR" "$PWSH_INSTALL_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
	x86_64)  PWSH_ARCH="x64" ;;
	aarch64) PWSH_ARCH="arm64" ;;
	*)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# ── Get latest version ────────────────────────────────────────
echo "Checking latest PowerShell version..."
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/PowerShell/PowerShell/releases/latest" | grep '"tag_name"' | sed 's/.*"v\(.*\)".*/\1/')
DOWNLOAD_URL="https://github.com/PowerShell/PowerShell/releases/download/v${LATEST_TAG}/powershell-${LATEST_TAG}-linux-${PWSH_ARCH}.tar.gz"

# ── Check existing installation ───────────────────────────────
if [ -x "$PWSH_INSTALL_DIR/pwsh" ]; then
	CURRENT_VERSION=$("$PWSH_INSTALL_DIR/pwsh" --version 2>/dev/null | sed 's/PowerShell //' || echo "unknown")
	if [ "$CURRENT_VERSION" = "$LATEST_TAG" ]; then
		echo "PowerShell $CURRENT_VERSION already installed (latest)."
		exit 0
	fi
	echo "Updating PowerShell: $CURRENT_VERSION → $LATEST_TAG"
else
	echo "Installing PowerShell $LATEST_TAG ($PWSH_ARCH)..."
fi

# ── Download and extract ──────────────────────────────────────
TMP_TAR=$(mktemp /tmp/pwsh-XXXXXX.tar.gz)
curl -fsSL "$DOWNLOAD_URL" -o "$TMP_TAR"
rm -rf "$PWSH_INSTALL_DIR"/*
tar -xzf "$TMP_TAR" -C "$PWSH_INSTALL_DIR"
rm -f "$TMP_TAR"
chmod +x "$PWSH_INSTALL_DIR/pwsh"

# Symlink to bin dir
ln -sf "$PWSH_INSTALL_DIR/pwsh" "$BIN_DIR/pwsh"

# ── Persist environment in .env.sh ────────────────────────────
ensure_env_line "export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1"

echo ""
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
echo "Done ✅"
echo "  pwsh: $("$BIN_DIR/pwsh" --version)"
echo ""
echo "Environment persisted in /workspace/.env.sh"
