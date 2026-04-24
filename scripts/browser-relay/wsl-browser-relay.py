#!/usr/bin/env python3
"""Simple HTTP relay that opens container-supplied URLs on the WSL2 host."""

import argparse
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

MAX_URL_LENGTH = 8192
MIN_OPEN_INTERVAL_SEC = 0.5
OPENER = None
_last_open_time = 0.0


def find_opener():
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

        now = time.monotonic()
        if now - _last_open_time < MIN_OPEN_INTERVAL_SEC:
            self._respond(429, "Too fast")
            return
        _last_open_time = now

        try:
            subprocess.Popen([OPENER, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            display = url if len(url) <= 120 else url[:117] + "..."
            print(f"  → opened: {display}")
            self._respond(200, "OK")
        except Exception as exc:
            print(f"  ✗ failed: {exc}", file=sys.stderr)
            self._respond(500, "Internal error")

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, fmt, *args):
        del fmt, args


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
    print("  waiting for URLs...")

    server = HTTPServer((args.bind, args.port), RelayHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
