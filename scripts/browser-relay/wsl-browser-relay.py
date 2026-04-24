#!/usr/bin/env python3
"""
wsl-browser-relay — HTTP listener that opens URLs in the Windows browser via WSL interop.

Run this on the WSL2 host (not inside the container).
Listens on port 9222 (configurable) and opens received URLs using wslview or xdg-open.

Usage:
    python3 wsl-browser-relay.py [--port 9222] [--bind 127.0.0.1]

    # Or as a systemd user service (see install instructions below)

Install as systemd user service:
    mkdir -p ~/.config/systemd/user
    cp wsl-browser-relay.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now wsl-browser-relay
"""

import argparse
import shutil
import subprocess
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

MAX_URL_LENGTH = 8192
MIN_OPEN_INTERVAL_SEC = 0.5

OPENER = None
_last_open_time = 0.0


def find_opener():
    """Find the best available URL opener."""
    for cmd in ("wslview", "xdg-open"):
        path = shutil.which(cmd)
        if path:
            return path
    return None


class RelayHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global _last_open_time

        parsed = urlparse(self.path)

        if parsed.path != "/open":
            self._respond(404, "Not found")
            return

        if not OPENER:
            self._respond(503, "No opener configured")
            return

        params = parse_qs(parsed.query)
        url = params.get("url", [""])[0]

        if not url:
            self._respond(400, "Missing url parameter")
            return

        if len(url) > MAX_URL_LENGTH:
            self._respond(414, "URL too long")
            return

        if not url.startswith(("http://", "https://")):
            self._respond(400, "Invalid URL scheme")
            return

        # Rate limit: prevent tab-flood
        now = time.monotonic()
        if now - _last_open_time < MIN_OPEN_INTERVAL_SEC:
            self._respond(429, "Too fast")
            return
        _last_open_time = now

        try:
            subprocess.Popen(
                [OPENER, url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            display = url if len(url) <= 120 else url[:117] + "..."
            print(f"  → opened: {display}")
            self._respond(200, "OK")
        except Exception as e:
            print(f"  ✗ failed: {e}", file=sys.stderr)
            self._respond(500, "Internal error")

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, format, *args):
        # Access logging via print in do_GET for successful opens
        pass


def main():
    global OPENER

    parser = argparse.ArgumentParser(description="WSL browser relay for containers")
    parser.add_argument("--port", type=int, default=9222, help="Listen port (default: 9222)")
    parser.add_argument("--bind", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    args = parser.parse_args()

    OPENER = find_opener()
    if not OPENER:
        print("ERROR: No URL opener found (tried: wslview, xdg-open)", file=sys.stderr)
        print("Install wslu: sudo apt install wslu", file=sys.stderr)
        sys.exit(1)

    print(f"wsl-browser-relay listening on {args.bind}:{args.port}")
    print(f"  opener: {OPENER}")
    print(f"  waiting for URLs...")

    server = HTTPServer((args.bind, args.port), RelayHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
