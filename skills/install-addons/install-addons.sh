#!/usr/bin/env bash
set -euo pipefail

# Install piclaw-addons extensions and scripts into the workspace.
# Safe to run multiple times (idempotent).

REPO="https://github.com/rcarmo/piclaw-addons.git"
TMP_DIR=$(mktemp -d)
WORKSPACE="${WORKSPACE:-/workspace}"

echo "📦 Cloning piclaw-addons..."
git clone --depth 1 "$REPO" "$TMP_DIR" 2>&1

# Extensions
echo "🔌 Installing extensions..."
mkdir -p "$WORKSPACE/.pi/extensions"
for ext in "$TMP_DIR"/extensions/*.ts; do
  [ -f "$ext" ] || continue
  name=$(basename "$ext")
  cp "$ext" "$WORKSPACE/.pi/extensions/$name"
  echo "  ✅ $name"
done

# Scripts
echo "📜 Installing scripts..."
mkdir -p "$WORKSPACE/scripts/lib"
for script in "$TMP_DIR"/scripts/*.sh; do
  [ -f "$script" ] || continue
  name=$(basename "$script")
  cp "$script" "$WORKSPACE/scripts/$name"
  chmod +x "$WORKSPACE/scripts/$name"
  echo "  ✅ $name"
done

# Script libs
for lib in "$TMP_DIR"/scripts/lib/*.sh; do
  [ -f "$lib" ] || continue
  name=$(basename "$lib")
  cp "$lib" "$WORKSPACE/scripts/lib/$name"
  chmod +x "$WORKSPACE/scripts/lib/$name"
  echo "  ✅ lib/$name"
done

# Cleanup
rm -rf "$TMP_DIR"

echo ""
echo "✅ piclaw-addons installed. Restart PiClaw to load extensions."
