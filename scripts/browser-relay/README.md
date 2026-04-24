# WSL2 Browser Relay

Open URLs from inside Docker containers in your Windows browser.

This is useful for interactive OAuth or local-UI flows such as:

- `az login`
- `jupyter notebook`
- tools that call Python `webbrowser.open()`

## Layout

- `browser-relay` — container-side `BROWSER=` shim that forwards a URL to the host relay
- `install-browser-relay.sh` — container-side setup helper
- `wsl-browser-relay.py` — tiny HTTP server that runs on the WSL2 host and opens URLs with `wslview`
- `wsl-browser-relay.service` — optional systemd user service for the host-side relay

## Requirements

- PiClaw container running with host networking
- WSL2 mirrored mode so `localhost` is shared with Windows
- `wslu` installed on the WSL2 host (`sudo apt install wslu`)

## Container-side setup

Run inside the PiClaw container:

```bash
cd /workspace/piclaw-addons/scripts/browser-relay
./install-browser-relay.sh
```

This configures:

- `BROWSER=/workspace/piclaw-addons/scripts/browser-relay/browser-relay`
- `BROWSER_RELAY_HOST=localhost`
- `BROWSER_RELAY_PORT=9222`

If the `piclaw env` CLI is available, the script uses it so the variables are activated immediately and persisted. Otherwise it appends the exports to `/workspace/.env.sh`.

## Host-side setup

Run on the WSL2 host, not in the container:

```bash
sudo apt install wslu
mkdir -p ~/.config/systemd/user ~/.local/bin
cp /workspace/piclaw-addons/scripts/browser-relay/wsl-browser-relay.py ~/.local/bin/
cp /workspace/piclaw-addons/scripts/browser-relay/wsl-browser-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wsl-browser-relay
```

Or run it manually:

```bash
python3 /workspace/piclaw-addons/scripts/browser-relay/wsl-browser-relay.py
```

## How it works

```text
Container (BROWSER=browser-relay)
  -> HTTP GET /open?url=...
WSL2 host relay (wsl-browser-relay.py)
  -> wslview
Windows default browser
```

The relay only accepts `http://` and `https://` URLs and rate-limits launches to avoid tab floods.
