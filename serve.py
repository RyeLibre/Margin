"""Margin Reader server for Mac/Linux: python3 serve.py  ->  http://localhost:8765/"""
import http.server, os, socketserver, webbrowser

PORT = 8765
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
                      '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        super().end_headers()
    def log_message(self, *a): pass

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True; allow_reuse_address = True

if __name__ == '__main__':
    with Server(('127.0.0.1', PORT), Handler) as s:
        print(f'Margin Reader running at http://localhost:{PORT}/  (Ctrl+C to stop)')
        if os.environ.get('NO_BROWSER') != '1':
            webbrowser.open(f'http://localhost:{PORT}/')
        s.serve_forever()
