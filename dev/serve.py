#!/usr/bin/env python3
"""Dev server for the SchReader harness.

Serves the repo over http and accepts POST /save?name=<file> so the browser can hand
the extracted article model back to the filesystem (a plain static server can't).

    python3 dev/serve.py [port]
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEV = os.path.join(ROOT, "dev")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, format, *args):
        pass  # keep the console quiet

    def end_headers(self):
        # a stale .js here makes the harness test last hour's code (and quietly "proves" a fix)
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/save":
            self.send_error(404)
            return
        name = (parse_qs(u.query).get("name") or ["capture.json"])[0]
        name = os.path.basename(name)  # no traversal
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            data = json.loads(raw.decode("utf-8"))
            text = json.dumps(data, indent=1, ensure_ascii=False)
        except Exception:
            text = raw.decode("utf-8", "replace")
        os.makedirs(DEV, exist_ok=True)
        with open(os.path.join(DEV, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        body = json.dumps({"ok": True, "bytes": len(text)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"serving {ROOT} on http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()
