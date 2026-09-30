"""Static test server: the same app at /, /barber-app/ and /cloudflare/.

/cloudflare/ mimics the default behaviour of Cloudflare Workers static assets and
Cloudflare Pages ("pretty URLs"): /index.html answers with a redirect to /. The
installed PWA starts from exactly such URLs, so a Service Worker that mishandles
redirects makes the app fail to open only on these hosts.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "barber-app"

# prefix -> (redirect status for "/prefix" without slash, redirect /index.html to /)
MOUNTS = {
    "/barber-app": (301, False),
    "/cloudflare": (307, True),
}


class Handler(SimpleHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass  # браузер оборвал соединение (переход на другую страницу, офлайн): это не ошибка теста

    def redirect(self, status, location):
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path, question, query = self.path.partition("?")
        suffix = question + query
        for prefix, (status, pretty) in MOUNTS.items():
            if path == prefix:
                return self.redirect(status, prefix + "/" + suffix)
            if path.startswith(prefix + "/"):
                inner = path[len(prefix):]
                if pretty and inner == "/index.html":
                    return self.redirect(307, prefix + "/" + suffix)
                self.path = inner + suffix
                break
        super().do_GET()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    ThreadingHTTPServer(("0.0.0.0", args.port), partial(Handler, directory=str(APP))).serve_forever()
