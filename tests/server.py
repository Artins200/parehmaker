"""Static test server: the same app at / and /barber-app/."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "barber-app"


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/barber-app":
            self.send_response(301)
            self.send_header("Location", "/barber-app/")
            self.end_headers()
            return
        if self.path.startswith("/barber-app/"):
            self.path = self.path[len("/barber-app"):]
        super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    ThreadingHTTPServer(("0.0.0.0", args.port), partial(Handler, directory=str(APP))).serve_forever()
