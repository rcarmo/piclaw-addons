# WSL2 Browser Relay

Open URLs from inside Docker containers in your Windows browser — enabling interactive OAuth flows like `az login` without `--use-device-code`.

## The problem

Tools like `az login`, `jupyter notebook`, and anything using Python's `webbrowser.open()` need a browser for interactive authentication or UI. Inside a Docker container running on WSL2, there is no browser and no access to WSL's Windows interop layer:

- `/proc/sys/fs/binfmt_misc/WSLInterop` is not registered (no `.exe` execution)
- `wslview`, `powershell.exe`, `cmd.exe` are not available
- `/mnt/c/` is not mounted
- `WSL_INTEROP` socket is not present

The usual workaround is `az login --use-device-code`, which requires manually copying a code and opening a URL. This breaks automation and adds friction to every auth renewal.

## The solution

A lightweight HTTP relay that bridges the gap between the container and the Windows browser:

```
Container                          WSL2 host                     Windows
┌─────────────┐     HTTP GET      ┌──────────────────┐         ┌─────────┐
│ az login     │ ──────────────── │ wsl-browser-relay │ ──────▶ │ Browser │
│   ↓          │  localhost:9222  │  (Python listener) │ wslview │         │
│ BROWSER=     │                  └──────────────────┘         │         │
│ browser-relay│                                                │         │
│              │ ◀────────────────────────────────────────────── │ OAuth   │
│ callback :P  │         OAuth redirect to localhost:P          │ redirect│
└─────────────┘                                                 └─────────┘
```

1. `az login` calls the `$BROWSER` script with the OAuth URL
2. `browser-relay` (container) sends the URL via HTTP to `localhost:9222`
3. `wsl-browser-relay.py` (WSL2 host) receives it and calls `wslview` to open the Windows browser
4. User authenticates in the browser
5. The OAuth redirect goes to `localhost:<random_port>` which reaches the `az login` callback server inside the container

**Why the callback works:** With `network_mode: host`, the container shares the WSL2 network namespace. With WSL2 mirrored networking, `localhost` is shared between WSL2 and Windows. So `localhost:PORT` from the browser reaches the container directly.

## Assumptions

- **WSL2 with systemd**: Your WSL2 distribution has systemd enabled (Ubuntu 24.04 default). Verify with `cat /etc/wsl.conf` — should contain `[boot] systemd=true`.
- **WSL2 mirrored networking**: `localhost` is shared between Windows and WSL2. This is the default in recent WSL2 builds. Verify with `.wslconfig` under `[wsl2] networkingMode=mirrored` or test with a simple `python3 -m http.server` from WSL2 and accessing it from Windows.
- **Container `network_mode: host`**: The container shares the WSL2 host network namespace (set in `docker-compose.yml` / `podman-compose.yml`). This means `localhost` inside the container is the same as `localhost` on the WSL2 host.
- **`wslu` installed on WSL2 host**: The `wslu` package provides `wslview`, which opens URLs in the default Windows browser. Install with `sudo apt install wslu`.

## Prerequisites

| Component | Where | How to verify |
|---|---|---|
| WSL2 with systemd | Windows host | `wsl --version` and `cat /etc/wsl.conf` |
| `wslu` package | WSL2 host | `which wslview` — if missing: `sudo apt install wslu` |
| Python 3 | WSL2 host | `python3 --version` (stdlib only, no pip packages needed) |
| Container with `network_mode: host` | `docker-compose.yml` | `grep network_mode docker-compose.yml` |
| `curl` in container | Container | `which curl` (included in piclaw image) |

## Files

| File | Runs on | Purpose |
|---|---|---|
| `browser-relay` | Container | Bash script set as `$BROWSER`. Receives a URL argument, sends it to the relay via HTTP |
| `wsl-browser-relay.py` | WSL2 host | Python HTTP listener. Receives URLs on port 9222, opens them with `wslview` |
| `wsl-browser-relay.service` | WSL2 host | Systemd user service unit for auto-start |
| `install-browser-relay.sh` | Container | Setup script: makes `browser-relay` executable, adds `BROWSER` to `.env.sh` |

## Setup

### Step 1: Container side

Run the install script inside the container:

```bash
bash /workspace/.local/bin/install-browser-relay.sh
```

This:
- Makes `browser-relay` executable
- Adds `BROWSER`, `BROWSER_RELAY_PORT`, and `BROWSER_RELAY_HOST` to `/workspace/.env.sh`
- Tests connectivity to the relay (will fail until Step 2 is done)

The `.env.sh` hook persists across container restarts since `/workspace` is a volume mount.

### Step 2: WSL2 host side (one-time)

Copy the relay files and enable the systemd service:

```bash
# Create directories
mkdir -p ~/.local/bin ~/.config/systemd/user

# Copy from the container workspace volume
# Adjust the path to match your workspace mount point
cp /path/to/workspace/.local/bin/wsl-browser-relay.py ~/.local/bin/
cp /path/to/workspace/.local/bin/wsl-browser-relay.service ~/.config/systemd/user/

# Enable and start the service
systemctl --user daemon-reload
systemctl --user enable --now wsl-browser-relay

# Verify
systemctl --user status wsl-browser-relay
```

Or run manually for testing:

```bash
python3 ~/.local/bin/wsl-browser-relay.py
```

### Step 3: Test

From inside the container:

```bash
az login
```

The Microsoft login page should open in your Windows browser. After authenticating, the OAuth callback completes automatically.

## Configuration

| Environment variable | Default | Set in | Description |
|---|---|---|---|
| `BROWSER` | `/workspace/.local/bin/browser-relay` | `.env.sh` | Path to the relay script |
| `BROWSER_RELAY_PORT` | `9222` | `.env.sh` | Port the WSL2 host listener runs on |
| `BROWSER_RELAY_HOST` | `localhost` | `.env.sh` | Host to send URLs to |

The WSL2 host listener accepts `--port` and `--bind` arguments:

```bash
python3 wsl-browser-relay.py --port 9222 --bind 127.0.0.1
```

## Security

The relay is designed with defense-in-depth:

| Measure | Description |
|---|---|
| **Bind to 127.0.0.1 only** | Listener accepts connections only from localhost — not reachable from the network |
| **URL scheme validation** | Only `http://` and `https://` URLs are accepted |
| **URL length limit** | Maximum 8192 characters — prevents memory exhaustion |
| **Rate limiting** | Minimum 0.5s between opens — prevents tab-flood attacks |
| **Input validation** | Host and port environment variables validated against strict patterns |
| **No shell interpolation** | URLs passed as list arguments to `subprocess.Popen`, not through a shell |
| **No sensitive data in errors** | Error responses to clients are generic; details logged server-side only |

## Compatible tools

Any tool that respects the `$BROWSER` environment variable or uses Python's `webbrowser.open()`:

- `az login` (Azure CLI)
- `jupyter notebook` / `jupyter lab`
- `gh auth login --web` (GitHub CLI)
- `gcloud auth login` (Google Cloud CLI)
- Python scripts using `webbrowser.open()`

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `browser-relay: failed to reach relay` | Host listener not running | Start `wsl-browser-relay` on WSL2 host |
| `browser-relay: invalid port` | `BROWSER_RELAY_PORT` contains non-numeric value | Check `.env.sh` for correct port |
| `ERROR: No URL opener found` | `wslu` not installed on WSL2 host | `sudo apt install wslu` |
| Browser opens but auth callback fails | Container not using `network_mode: host` | Check `docker-compose.yml` |
| Browser opens but callback times out | WSL2 mirrored networking not enabled | Check `.wslconfig` for `networkingMode=mirrored` |
| Service stops when WSL2 idles | WSL2 shuts down after idle timeout | Keep a terminal open or configure `wsl --shutdown` timeout |

## How it works (detailed)

### The `$BROWSER` convention

Unix tools that need to open a URL check the `$BROWSER` environment variable. If set, they execute `$BROWSER <url>` as a subprocess. Python's `webbrowser` module (used by `az login`) follows the same convention. By setting `BROWSER=/workspace/.local/bin/browser-relay`, all browser-open requests are intercepted.

### The HTTP relay

`browser-relay` is a minimal bash script. When called with a URL:

1. Validates `BROWSER_RELAY_HOST` and `BROWSER_RELAY_PORT` against strict patterns
2. Sends `GET /open?url=<encoded_url>` to `http://localhost:9222` via `curl`
3. `curl` handles URL-encoding via `--data-urlencode` (no external dependencies)

`wsl-browser-relay.py` is a stdlib Python HTTP server. When it receives a request:

1. Validates the URL (scheme, length)
2. Checks rate limit (0.5s minimum between opens)
3. Calls `wslview <url>` via `subprocess.Popen` (list-based, no shell)
4. `wslview` uses WSL interop to open the URL in the default Windows browser

### The OAuth callback

`az login` starts a temporary HTTP server on a random port (e.g. `localhost:44683`) before opening the browser. The OAuth URL includes `redirect_uri=http://localhost:44683`. After the user authenticates, Microsoft redirects the browser to this URL. Because the container, WSL2, and Windows all share `localhost` (via `network_mode: host` and WSL2 mirrored networking), the redirect reaches the `az login` callback server inside the container, completing the authentication flow.

### Why `wslview` can't run inside the container

WSL interop (the ability to call `.exe` files from Linux) requires kernel-level support registered via `/proc/sys/fs/binfmt_misc/WSLInterop` and the `WSL_INTEROP` IPC socket. Docker/Podman containers run in isolated namespaces that don't inherit these mechanisms, even with `network_mode: host`. The relay works around this by splitting the work: the container handles HTTP, the WSL2 host handles the Windows interop.
