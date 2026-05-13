"""Atlas HTTP + WebSocket server.

Uses only Python stdlib so it runs without installing anything. Serves the
3D UI from /, exposes a JSON API under /api/, and pushes live graph updates
over /ws.
"""

from __future__ import annotations

import json
import os
import socket
import struct
import threading
import time
from base64 import b64encode
from hashlib import sha1
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import agents, brain, memory
from .learner import Learner

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_clients: list[socket.socket] = []
_clients_lock = threading.Lock()


def _broadcast(payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    frame = _encode_ws_frame(data)
    dead = []
    with _clients_lock:
        for sock in _clients:
            try:
                sock.sendall(frame)
            except Exception:
                dead.append(sock)
        for sock in dead:
            _clients.remove(sock)
            try:
                sock.close()
            except Exception:
                pass


def _encode_ws_frame(payload: bytes) -> bytes:
    header = bytearray([0x81])  # FIN + text
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < (1 << 16):
        header.append(126)
        header.extend(struct.pack(">H", length))
    else:
        header.append(127)
        header.extend(struct.pack(">Q", length))
    return bytes(header) + payload


def _read_ws_frame(sock: socket.socket) -> str | None:
    hdr = _recv_exact(sock, 2)
    if not hdr:
        return None
    b1, b2 = hdr[0], hdr[1]
    opcode = b1 & 0x0F
    if opcode == 0x8:
        return None
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _recv_exact(sock, 8))[0]
    mask = _recv_exact(sock, 4) if masked else b"\x00\x00\x00\x00"
    payload = _recv_exact(sock, length)
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return buf
        buf += chunk
    return buf


def _broadcaster_loop() -> None:
    last_stats = None
    while True:
        try:
            snapshot = brain.graph_snapshot()
            stats = memory.stats()
            thoughts = memory.recent_thoughts(5)
            if stats != last_stats:
                _broadcast({
                    "type": "graph",
                    "graph": snapshot,
                    "stats": stats,
                    "recent_thoughts": thoughts,
                })
                last_stats = stats
            else:
                _broadcast({
                    "type": "tick",
                    "stats": stats,
                    "recent_thoughts": thoughts,
                })
        except Exception:
            pass
        time.sleep(3.0)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence default access log
        pass

    # ----- routing ---------------------------------------------------------

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/ws":
            self._handle_ws()
            return
        if url.path.startswith("/api/"):
            self._handle_api("GET", url.path)
            return
        self._serve_static(url.path)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            self._handle_api("POST", url.path)
            return
        self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            self._handle_api("DELETE", url.path)
            return
        self._send_json({"error": "not found"}, 404)

    # ----- helpers ---------------------------------------------------------

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, path: str) -> None:
        if path == "/" or path == "":
            file_path = FRONTEND_DIR / "index.html"
        else:
            file_path = FRONTEND_DIR / path.lstrip("/")
        if not file_path.exists() or not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            return
        ext = file_path.suffix.lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
        }.get(ext, "application/octet-stream")
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ----- websocket -------------------------------------------------------

    def _handle_ws(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_response(400)
            self.end_headers()
            return
        accept = b64encode(sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        sock = self.connection
        with _clients_lock:
            _clients.append(sock)
        # initial snapshot
        try:
            sock.sendall(_encode_ws_frame(json.dumps({
                "type": "graph",
                "graph": brain.graph_snapshot(),
                "stats": memory.stats(),
                "recent_thoughts": memory.recent_thoughts(5),
            }).encode("utf-8")))
        except Exception:
            pass
        try:
            while True:
                msg = _read_ws_frame(sock)
                if msg is None:
                    break
                # incoming messages can request a refresh
                try:
                    payload = json.loads(msg)
                except Exception:
                    continue
                if payload.get("type") == "refresh":
                    sock.sendall(_encode_ws_frame(json.dumps({
                        "type": "graph",
                        "graph": brain.graph_snapshot(),
                        "stats": memory.stats(),
                        "recent_thoughts": memory.recent_thoughts(5),
                    }).encode("utf-8")))
        finally:
            with _clients_lock:
                if sock in _clients:
                    _clients.remove(sock)

    # ----- api -------------------------------------------------------------

    def _handle_api(self, method: str, path: str) -> None:
        parts = path.strip("/").split("/")
        # parts[0] == 'api'
        try:
            if method == "GET" and parts == ["api", "stats"]:
                return self._send_json(memory.stats())
            if method == "GET" and parts == ["api", "graph"]:
                return self._send_json(brain.graph_snapshot())
            if method == "GET" and parts == ["api", "chats"]:
                return self._send_json(memory.recent_chats(200))
            if method == "GET" and parts == ["api", "thoughts"]:
                return self._send_json(memory.recent_thoughts(50))
            if method == "GET" and len(parts) == 3 and parts[1] == "node":
                node = memory.get_node(int(parts[2]))
                if not node:
                    return self._send_json({"error": "not found"}, 404)
                node["neighbors"] = memory.neighbors(node["id"])
                return self._send_json(node)
            if method == "POST" and parts == ["api", "learn"]:
                body = self._read_body()
                result = brain.learn(body.get("text", ""),
                                     source=body.get("source", "user"))
                return self._send_json(result)
            if method == "POST" and parts == ["api", "think"]:
                body = self._read_body()
                return self._send_json(brain.think(body.get("focus")))
            if method == "POST" and parts == ["api", "chat"]:
                body = self._read_body()
                question = body.get("message", "")
                memory.remember_chat("user", question)
                answer = brain.answer(question)
                memory.remember_chat("atlas", answer["reply"],
                                     node_refs=answer.get("refs", []))
                return self._send_json(answer)
            if method == "GET" and parts == ["api", "agents"]:
                return self._send_json(agents.manager.list())
            if method == "POST" and parts == ["api", "agents"]:
                body = self._read_body()
                row = agents.manager.create(
                    name=body.get("name", "unnamed"),
                    purpose=body.get("purpose", ""),
                    code=body.get("code", "def run(ctx):\n    pass\n"),
                    schedule_seconds=float(body.get("schedule_seconds", 60)),
                )
                return self._send_json(row)
            if method == "POST" and len(parts) == 4 and parts[1] == "agents" \
                    and parts[3] == "run":
                return self._send_json(agents.manager.run_now(int(parts[2])))
            if method == "POST" and len(parts) == 4 and parts[1] == "agents" \
                    and parts[3] == "code":
                body = self._read_body()
                return self._send_json(agents.manager.update_code(
                    int(parts[2]), body.get("code", "")))
            if method == "DELETE" and len(parts) == 3 and parts[1] == "agents":
                agents.manager.delete(int(parts[2]))
                return self._send_json({"ok": True})
        except Exception as exc:
            return self._send_json({"error": str(exc)}, 500)
        return self._send_json({"error": "not found"}, 404)


def start(host: str = "0.0.0.0", port: int = 8765) -> None:
    learner = Learner()
    learner.start()
    agents.install_starter_agents()
    agents.manager.start()
    threading.Thread(target=_broadcaster_loop, name="atlas-broadcaster",
                     daemon=True).start()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Atlas online at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nAtlas shutting down.")
        learner.stop()
        agents.manager.stop()
        server.server_close()


if __name__ == "__main__":
    port = int(os.environ.get("ATLAS_PORT", "8765"))
    start(port=port)
