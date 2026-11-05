#!/usr/bin/env python3
"""Static dev server for web/ with the cross-origin isolation headers that SharedArrayBuffer
(pthreads, Wasm Audio Worklet) needs. usage: python3 web/serve.py [port]  (default: $PORT, else 8765)"""
import functools, http.server, os, sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PORT", 8765))
handler = functools.partial(Handler, directory=os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
