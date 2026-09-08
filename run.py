"""Serve only the local interaction prototype; no third-party dependencies."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    handler = partial(SimpleHTTPRequestHandler, directory=str(Path(__file__).parent / "prototype"))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"交互原型：http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
