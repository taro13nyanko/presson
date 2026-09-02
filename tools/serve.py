#!/usr/bin/env python
"""
PressOn local server — HTTPS (phones need it for motion sensors) + instructor relay.

    python tools/serve.py            # https://<your-LAN-IP>:8443
    python tools/serve.py --port 8443 --host 0.0.0.0

What it does
  * serves app/ over HTTPS with a self-signed certificate it generates once
    (certs/ folder). The phone shows a warning the first time: tap
    "Advanced" -> "Proceed". Motion sensors then work because the origin is https.
  * /api/ping    -> {"presson": true}     lets the app know the relay exists
  * /api/report  <- POST JSON from phones (every 0.5 s during a session)
  * /api/stream  -> Server-Sent Events for instructor.html (all phones live)
  * /api/llm     <- optional proxy for the AI debrief when the browser blocks
                    the cross-origin call (forwards to the URL given in the body)

No third-party packages. Python 3.8+.
"""
import argparse
import http.server
import json
import os
import queue
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
CERTS = os.path.join(ROOT, "certs")

reports = {}                 # id -> last report
subscribers = []             # list of queue.Queue
lock = threading.Lock()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERTS, exist_ok=True)
    crt, key = os.path.join(CERTS, "presson.crt"), os.path.join(CERTS, "presson.key")
    if os.path.exists(crt) and os.path.exists(key):
        return crt, key
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        import datetime
        import ipaddress
        k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "PressOn local")])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(k.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
                .not_valid_after(now + datetime.timedelta(days=825))
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(ip)), x509.DNSName("localhost")]), critical=False)
                .sign(k, hashes.SHA256()))
        with open(key, "wb") as f:
            f.write(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        with open(crt, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
        return crt, key
    except ImportError:
        pass
    # fall back to the openssl binary (Git for Windows ships one)
    candidates = ["openssl", r"C:\Program Files\Git\usr\bin\openssl.exe"]
    for exe in candidates:
        try:
            subprocess.run([exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "825",
                            "-subj", "/CN=PressOn local", "-addext", f"subjectAltName=IP:{ip},DNS:localhost"],
                           check=True, capture_output=True)
            return crt, key
        except (OSError, subprocess.CalledProcessError):
            continue
    sys.exit("Could not create a certificate: pip install cryptography   (or install OpenSSL)")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP, **kw)

    def log_message(self, fmt, *args):      # quieter log
        if "/api/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/ping"):
            return self._json({"presson": True, "time": time.time()})
        if self.path.startswith("/api/stream"):
            return self._stream()
        if self.path.startswith("/api/reports"):
            with lock:
                return self._json(list(reports.values()))
        return super().do_GET()

    def _stream(self):
        q = queue.Queue()
        with lock:
            subscribers.append(q)
            snapshot = list(reports.values())
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(f"data: {json.dumps({'snapshot': snapshot})}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {json.dumps(msg)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with lock:
                if q in subscribers:
                    subscribers.remove(q)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            return self._json({"error": "bad json"}, 400)
        if self.path.startswith("/api/report"):
            data["received"] = time.time()
            with lock:
                reports[data.get("id", "?")] = data
                subs = list(subscribers)
            for q in subs:
                q.put(data)
            return self._json({"ok": True})
        if self.path.startswith("/api/llm"):
            return self._llm(data)
        return self._json({"error": "unknown"}, 404)

    def _llm(self, data):
        url, key, body = data.get("url"), data.get("key"), data.get("body")
        if not url or not key or not body:
            return self._json({"error": "url, key and body required"}, 400)
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload = r.read()
        except Exception as e:  # noqa: BLE001 - surface any failure to the page
            return self._json({"error": {"message": str(e)}}, 502)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--http", action="store_true", help="plain HTTP (desktop demo only; phones need HTTPS)")
    args = ap.parse_args()
    ip = lan_ip()
    srv = Server((args.host, args.port), Handler)
    scheme = "http"
    if not args.http:
        crt, key = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    print("PressOn server")
    print(f"  phone / trainee : {scheme}://{ip}:{args.port}/")
    print(f"  instructor      : {scheme}://{ip}:{args.port}/instructor.html")
    print(f"  this computer   : {scheme}://localhost:{args.port}/")
    if scheme == "https":
        print("  (first time on the phone: tap 'Advanced' -> 'Proceed' on the certificate warning)")
    print("Ctrl+C to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
