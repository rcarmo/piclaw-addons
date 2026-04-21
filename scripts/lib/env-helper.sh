#!/usr/bin/env bash
# Shared helper: ensure a line exists in /workspace/.env.sh
# Usage: ensure_env_line "export KEY=value"
#        ensure_env_line "mkdir -p /some/dir"

ENV_FILE="/workspace/.env.sh"

ensure_env_line() {
	local line="$1"
	touch "$ENV_FILE"
	if ! grep -qxF "$line" "$ENV_FILE"; then
		echo "$line" >> "$ENV_FILE"
	fi
}
