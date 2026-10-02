#!/usr/bin/env python3
"""Local server for findr.

Same as `python3 -m http.server`, but it tells the browser to check for a newer copy of every file on each
load. Without that, Chrome keeps reusing its cached page for a while, so code edits and fresh indexer data
don't show up on a normal reload.
"""
import functools
import http.server
import os

PORT = int(os.environ.get("PORT", "8765"))
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        # Never serve secrets or the indexer's internals: .env holds the Alchemy key.
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if any(p.startswith(".") for p in parts) or (parts and parts[0] in ("indexer", "node_modules")):
            self.send_error(404)
            return None
        return super().send_head()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    print(f"findr on http://127.0.0.1:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()
