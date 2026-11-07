#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
familylink_login_proxy.py — Fernlogin-Beistandsdienst auf dem Sammler (CT122).

Wenn die Google-Sitzung des Sammlers ablaeuft (401-Signatur der familyhub-
Skripte), oeffnet die Yuvomi-Eltern-UI eine Fernlogin-Sitzung: dieser Dienst
haelt den Browser-Bildschirm als Viewer-Seite bereit und leitet Klick, Scroll
und Tippen an das bestehende Chromium-Profil weiter (CDP :9333, Profil
~/.config/chromium-familyhub — alles wiederverwendet aus familyhub_capture2.py).
Erkennt der Dienst den erfolgreichen Login, schreibt ER die Cookies selbst
(session.json, 0600 — dasselbe Format wie der capture-Befehl von
familyhub_capture2.py), meldet {"status":"ok"} an die Report-Route und
navigiert das Fenster auf about:blank (getippte Daten bleiben nicht stehen).

Einrichtung (einmalig, auf dem Sammler):
  1. Freigabegeheimnis erzeugen und ablegen (identischer Inhalt wie die env
     FAMILYLINK_LOGIN_SECRET auf dem Yuvomi-Server, nie ins Repo):
       mkdir -p ~/.familyhub && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > ~/.familyhub/login_secret
       chmod 600 ~/.familyhub/login_secret
  2. Yuvomi-Server-Konfiguration (Deploy): FAMILYLINK_COLLECTOR_BASE =
     http://<sammler-ip>:9334 und FAMILYLINK_LOGIN_SECRET = derselbe Inhalt.
  3. Cron (CT122 haengt CIFS mit noexec — der Interpreter-Aufruf laeuft
     deshalb durch den bash -c Wrapper, Muster wie der bestehende
     familylink_push.sh-Eintrag). Watchdog alle fuenf Minuten, startet den
     Lauscher, falls er nicht laeuft (flock gegen Ueberlappen):
       */5 * * * * /usr/bin/flock -n /tmp/familylink-login-proxy.lock /usr/bin/bash -c \
         'pgrep -f "familylink_login_proxy.py" >/dev/null || \
          nohup python3 /pfad/zu/scripts/familylink/familylink_login_proxy.py >> ~/.familyhub/login_proxy.log 2>&1 &'

Vertrag (Freigabe nur fuer den Yuvomi-Server; alle Antworten ohne Sitzungsdaten):
  POST /login/start   {session_token, expires_at} + Bearer  -> 200 {ok:true}
                      (eine Sitzung zur Zeit; eine zweite Start ersetzt die alte)
  POST /login/cancel  Bearer                                -> 200 {ok:true}
  GET  /login/view?t=<session_token>                        -> Viewer-Seite
  GET  /login/stream?t=<session_token>                      -> SSE (Frames + Status)
  POST /login/input?t=<session_token> {kind, ...}           -> 200 {ok:true}
  GET  /health  (nur laeuft/was_laeuft, keine Daten)         -> 200
Auth: "Authorization: Bearer <inhalt ~/.familyhub/login_secret>" — falsch oder
fehlend -> 401. Die Viewer-Pfade beweisen das einmalige Sitzungs-Token; ein
abgelaufenes oder falsches Token ist 404. Es wird NIE etwas aus Cookies,
Passwoertern oder Token-Werten geschrieben (Logzeilen tragen Methode und Pfad
ohne Query).

Harte Grenzen: Ablauf aus expires_at, spaetestens nach 15 Minuten (HARD_MAX_TTL).
Kein Cookie, kein Passwort und kein Token-Wert verlaesst diesen Rechner als Log.
"""

import hmac
import importlib.util
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Wiederverwendung wie in familyhub_screen.py: das bestehende Capture-Modul
# bringt ensure_chromium, den handgeschriebenen WS-Client (cap.WS), CDP-HTTP,
# LOGIN_URL und den Session-Datei-Pfad mit.
CAP_DIR = os.environ.get("FAMILYHUB_SCRIPT_DIR", str(__import__("pathlib").Path(__file__).resolve().parent))
_spec = importlib.util.spec_from_file_location(
    "cap", os.path.join(CAP_DIR, "familyhub_capture2.py"))
cap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cap)

LOGIN_SECRET_FILE = os.path.expanduser("~/.familyhub/login_secret")
PUSH_TOKEN_FILE = os.path.expanduser("~/.familyhub/push_token")
YUVOMI_URL = os.environ.get("YUVOMI_URL", "http://172.30.95.198:3000")
REPORT_PATH = "/api/v1/media-time/familylink/report"
HARD_MAX_TTL = 15 * 60  # harte Obergrenze einer Sitzung in Sekunden
TOKEN_RE = re.compile(r"^[0-9a-f]{32,128}$")
MAX_BODY = 4096

# Enter/Backspace/Tab als echte Tasten (insertText kann das nicht).
KEYS = {
    "Enter": {"key": "Enter", "code": "Enter", "vk": 13, "text": "\r"},
    "Backspace": {"key": "Backspace", "code": "Backspace", "vk": 8},
    "Tab": {"key": "Tab", "code": "Tab", "vk": 9},
}


# ══════════════════════════════════════════════════════════════════════════
# Reine Logik (ohne Chromium testbar — test/test-familylink-login-proxy.py)
# ══════════════════════════════════════════════════════════════════════════

def read_login_secret():
    """Der erwartete Bearer-Wert (Datei 0600); None, wenn keine eingerichtet ist."""
    try:
        with open(LOGIN_SECRET_FILE) as f:
            secret = f.read().strip()
    except OSError:
        return None
    return secret or None


def bearer_ok(header_value, secret):
    """Zeitkonstanter Vergleich 'Authorization: Bearer X' gegen secret; ohne secret ist alles abgelehnt."""
    if not secret:
        return False
    m = re.match(r"^Bearer\s+(\S+)$", header_value or "")
    if not m:
        return False
    return hmac.compare_digest(m.group(1), secret)


def token_ok(token, expected):
    """Sitzungs-Token-Vergleich (Viewer/Eingabe): zeitkonstant, leer ist niemals gueltig."""
    if not isinstance(token, str) or not isinstance(expected, str) or not expected:
        return False
    return hmac.compare_digest(token, expected)


def parse_expiry(expires_at, now=None):
    """Frist aus expires_at (ISO, 'Z' oder Offset) als Epoch-Sekunde, hart auf
    HARD_MAX_TTL begrenzt. Ungueltig oder schon vorbei -> ValueError."""
    if now is None:
        now = time.time()
    s = str(expires_at or "").strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    exp = min(dt.timestamp(), now + HARD_MAX_TTL)
    if exp <= now:
        raise ValueError("expires_at liegt in der Vergangenheit")
    return exp


def report_status(status):
    """curl-Python-Aequivalent zu familylink_push.sh: ein Status an die
    Report-Route (Header x-familylink-token aus ~/.familyhub/push_token).
    Scheitern ist still — der Report ist Bonus, das Login die Hauptsache."""
    try:
        with open(PUSH_TOKEN_FILE) as f:
            token = f.read().strip()
    except OSError:
        return
    if not token:
        return
    try:
        req = urllib.request.Request(
            YUVOMI_URL + REPORT_PATH,
            data=json.dumps({"status": status}).encode(),
            headers={"content-type": "application/json", "x-familylink-token": token},
            method="POST")
        with urllib.request.urlopen(req, timeout=15):
            pass
    except Exception:
        pass


def write_session_json(cookies):
    """Dasselbe Format und Rechte wie der capture-Befehl von
    familyhub_capture2.py — atomar geschrieben (tmp + replace, 0600)."""
    d = os.path.dirname(cap.SESSION_FILE)
    os.makedirs(d, exist_ok=True)
    tmp = cap.SESSION_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"exported": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                   "cookies": cookies}, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, cap.SESSION_FILE)


# ══════════════════════════════════════════════════════════════════════════
# Die Sitzung: ein Page-Target, ein WS-Reader, ein Ticker
# ══════════════════════════════════════════════════════════════════════════

class Session:
    def __init__(self, token, expiry):
        self.token = token
        self.expiry = expiry
        self.state = "active"  # active | ok | expired | cancelled | error
        self.ws = None
        self._send_lock = threading.Lock()
        self._pending = {}
        self._seq = 0
        self._stop = threading.Event()
        self._done = False
        self._finish_lock = threading.Lock()
        self._subscribers = []
        self._sub_lock = threading.Lock()
        self._last_frame = None
        self._frame_meta = (1280, 800)

    # — CDP-Kommandos (Antwort-Verteilung ueber den einen Reader-Thread) ————

    def _send(self, obj):  # ruft den Aufrufer mit gehaltener _send_lock auf
        self.ws._send(obj)

    def _fire(self, obj):
        with self._send_lock:
            self._send(obj)

    def call(self, method, params=None, timeout=15):
        with self._send_lock:
            self._seq += 1
            my = self._seq
            ev = threading.Event()
            holder = {}
            self._pending[my] = (ev, holder)
            self._send({"id": my, "method": method, "params": params or {}})
        if not ev.wait(timeout):
            self._pending.pop(my, None)
            raise TimeoutError(method)
        rec = self._pending.pop(my, None)
        msg = (rec[1].get("msg") if rec else None) or holder.get("msg") or {}
        if "error" in msg:
            raise RuntimeError(method + ": " + str(msg["error"])[:160])
        return msg.get("result", {})

    def _reader(self):
        while not self._stop.is_set():
            try:
                m = self.ws._recv()
            except Exception:
                break
            mid = m.get("id")
            if mid is not None:
                rec = self._pending.get(mid)
                if rec:
                    rec[1]["msg"] = m
                    rec[0].set()
                continue
            if m.get("method") == "Page.screencastFrame":
                p = m.get("params", {})
                md = p.get("metadata", {})
                try:
                    w = int(md.get("deviceWidth") or 1280)
                    h = int(md.get("deviceHeight") or 800)
                except (TypeError, ValueError):
                    w, h = 1280, 800
                self._frame_meta = (w, h)
                frame = {"type": "frame", "data": p.get("data", ""), "w": w, "h": h}
                self._last_frame = frame
                self._seq += 1
                self._fire({"id": self._seq, "method": "Page.screencastFrameAck",
                           "params": {"sessionId": p.get("sessionId")}})
                self._broadcast(frame)
        # Reader-Ende (Verbindung kaputt oder Sitzung beendet)
        if not self._done and not self._stop.is_set():
            self.finish(False, "error")

    # — Aufbau / Abbau ————————————————————————————————————————————————

    def start(self):
        cap.ensure_chromium()
        self.ws = cap.ensure_page(cap.LOGIN_URL)
        t = threading.Thread(target=self._reader, daemon=True)
        t.start()
        for m in ("Page.enable", "Runtime.enable", "Network.enable"):
            self.call(m)
        self.call("Page.startScreencast", {
            "format": "jpeg", "quality": 60, "everyNthFrame": 1,
            "maxWidth": 1280, "maxHeight": 1024, "deviceScaleFactor": 1})
        t2 = threading.Thread(target=self._ticker, daemon=True)
        t2.start()

    def finish(self, capture, state):
        with self._finish_lock:
            if self._done:
                return
            self._done = True
        self.state = state
        try:
            if capture:
                cookies = self.call("Network.getAllCookies", timeout=20).get("cookies", [])
                write_session_json(cookies)   # Format/Rechte wie capture2.capture
                report_status("ok")
        except Exception:
            # Ein kaputtes Capture darf das Fenster nicht auf der Login-Seite
            # lassen: der Aufraeum-Pfad unten laeuft trotzdem.
            self.state = "error"
        finally:
            try:  # getippte Daten nicht stehen lassen
                with self._send_lock:
                    self._seq += 1
                    self._send({"id": self._seq, "method": "Page.navigate",
                                "params": {"url": "about:blank"}})
                time.sleep(0.4)
            except Exception:
                pass
            try:
                self._fire({"id": self._seq + 1, "method": "Page.stopScreencast"})
            except Exception:
                pass
            self._stop.set()
            try:
                self.ws.s.close()
            except Exception:
                pass
            self._broadcast({"type": "status", "state": self.state})
            global _session
            with _lock:
                if _session is self:
                    _session = None

    # — Login-Erkennung und TTL (Poll ~2s) ——————————————————————————————

    def _href(self):
        r = self.call("Runtime.evaluate",
                      {"expression": "location.href", "returnByValue": True},
                      timeout=10)
        return (r.get("result") or {}).get("value") or ""

    def _ticker(self):
        while not self._stop.wait(2.0):
            if time.time() > self.expiry:
                self.finish(False, "expired")
                return
            try:
                href = self._href()
            except Exception:
                continue
            # Erfolg: Family-Link-App geladen und NICHT mehr auf accounts.google.
            if href and "accounts.google" not in href and \
                    ("familylink.google.com" in href or "families.google.com" in href):
                self.finish(True, "ok")
                return

    # — Eingabe (Koordinaten normiert 0..1, zurueckskaliert auf Frame-Groesse) —

    def _mouse(self, mtype, nx, ny, dx=0, dy=0):
        w, h = self._frame_meta
        x = max(0, min(w - 1, int(nx * w)))
        y = max(0, min(h - 1, int(ny * h)))
        params = {"type": mtype, "x": x, "y": y}
        if mtype == "mouseWheel":
            params.update({"deltaX": dx, "deltaY": dy, "button": "none", "clickCount": 0})
        else:
            params.update({"button": "left", "clickCount": 1})
        self.call("Input.dispatchMouseEvent", params)

    def click(self, nx, ny):
        self._mouse("mousePressed", nx, ny)
        self._mouse("mouseReleased", nx, ny)

    def wheel(self, nx, ny, dy):
        self._mouse("mouseWheel", nx, ny, dy=int(max(-1000.0, min(1000.0, dy))))

    def text(self, s):
        self.call("Input.insertText", {"text": s})

    def key(self, name):
        d = KEYS[name]
        base = {"key": d["key"], "code": d["code"],
                "windowsVirtualKeyCode": d["vk"], "nativeVirtualKeyCode": d["vk"]}
        self.call("Input.dispatchKeyEvent", dict(base, type="keyDown"))
        if "text" in d:
            self.call("Input.dispatchKeyEvent", {"type": "char", "text": d["text"]})
        self.call("Input.dispatchKeyEvent", dict(base, type="keyUp"))

    # — Viewer-Verteilung (SSE) —————————————————————————————————————————

    def matches(self, token):
        return (self.state == "active" and time.time() <= self.expiry
                and token_ok(token, self.token))

    def subscribe(self):
        q = queue.Queue(maxsize=8)
        with self._sub_lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self._sub_lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _broadcast(self, ev):
        with self._sub_lock:
            for q in list(self._subscribers):
                try:
                    if ev["type"] == "frame":
                        # Nur das neueste Frame zaehlt: Altes vorher abraumend.
                        while True:
                            try:
                                old = q.get_nowait()
                            except queue.Empty:
                                break
                            if old.get("type") != "frame":
                                q.put_nowait(old)
                        q.put_nowait(ev)
                    else:
                        q.put_nowait(ev)
                except queue.Full:
                    pass


_lock = threading.Lock()
_session = None


def active_session():
    with _lock:
        return _session


def start_session(token, expiry):
    """Eine Sitzung zur Zeit: eine zweite ersetzt die alte (wie die App-Route,
    die den Cancel vor dem Start sendet — hier die Collector-Seite der Regel)."""
    global _session
    with _lock:
        old = _session
        _session = None
    if old:
        try:
            old.finish(False, "cancelled")
        except Exception:
            pass
    sess = Session(token, expiry)
    sess.start()
    with _lock:
        _session = sess
    return sess


def cancel_session():
    with _lock:
        s = _session
    if s:
        try:
            s.finish(False, "cancelled")
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════
# HTTP
# ══════════════════════════════════════════════════════════════════════════

class Handler(BaseHTTPRequestHandler):
    server_version = "FamilyLinkLoginProxy/1"

    def log_message(self, fmt, *args):
        # Die Default-Zeile enthielt den Pfad MIT ?t=<token> — das bleibt draussen.
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?", 1)[0]))

    # — Helfer ————————————————————————————————————————————————————————

    def _reply(self, code, body=b"", ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json_in(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _authed(self):
        return bearer_ok(self.headers.get("Authorization"), read_login_secret())

    # — GET ———————————————————————————————————————————————————————————

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        t = (urllib.parse.parse_qs(u.query).get("t") or [""])[0]
        if u.path == "/health":
            return self._reply(200, json.dumps(
                {"ok": True, "session": active_session() is not None}).encode())
        if u.path in ("/login/view", "/login/stream"):
            sess = active_session()
            if not (sess and sess.matches(t)):
                return self._reply(404, json.dumps({"error": "no_session"}).encode())
            if u.path == "/login/view":
                return self._reply(200, VIEWER_HTML.encode("utf-8"),
                                   "text/html; charset=utf-8")
            return self._sse(sess)
        return self._reply(404, json.dumps({"error": "not_found"}).encode())

    def _sse(self, sess):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        q = sess.subscribe()
        try:
            if sess._last_frame:
                self._event(sess._last_frame)  # Reload zeigt sofort das letzte Bild
            self._event({"type": "status", "state": sess.state})
            while sess.state == "active" and not sess._stop.is_set():
                try:
                    ev = q.get(timeout=5)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._event(ev)
            self._event({"type": "status", "state": sess.state})
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            sess.unsubscribe(q)

    def _event(self, obj):
        self.wfile.write(("data: " + json.dumps(obj) + "\n\n").encode())
        self.wfile.flush()

    # — POST ——————————————————————————————————————————————————————————

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/login/start":
            if not self._authed():
                return self._reply(401, json.dumps({"error": "unauthorized"}).encode())
            body = self._json_in() or {}
            token = body.get("session_token")
            if not isinstance(token, str) or not TOKEN_RE.match(token):
                return self._reply(400, json.dumps({"error": "bad_token"}).encode())
            try:
                expiry = parse_expiry(body.get("expires_at"))
            except (ValueError, TypeError):
                return self._reply(400, json.dumps({"error": "bad_expiry"}).encode())
            try:
                start_session(token, expiry)
            except Exception:
                # Kein Grundtext aus Chromium-Fehlern hierher — er koennte
                # Ziel-URLs tragen; die Art steht im Log, nicht in der Antwort.
                sys.stderr.write("login/start: Chromium/CDP-Start fehlgeschlagen\n")
                return self._reply(500, json.dumps({"error": "start_failed"}).encode())
            return self._reply(200, json.dumps({"ok": True}).encode())
        if u.path == "/login/cancel":
            if not self._authed():
                return self._reply(401, json.dumps({"error": "unauthorized"}).encode())
            cancel_session()
            return self._reply(200, json.dumps({"ok": True}).encode())
        if u.path == "/login/input":
            t = (urllib.parse.parse_qs(u.query).get("t") or [""])[0]
            sess = active_session()
            if not (sess and sess.matches(t)):
                return self._reply(404, json.dumps({"error": "no_session"}).encode())
            body = self._json_in() or {}
            kind = body.get("kind")
            try:
                if kind == "click":
                    sess.click(_num(body, "nx"), _num(body, "ny"))
                elif kind == "wheel":
                    sess.wheel(_num(body, "nx"), _num(body, "ny"),
                               float(body.get("dy") or 0))
                elif kind == "text":
                    s = body.get("text")
                    if not isinstance(s, str) or not s or len(s) > 256:
                        return self._reply(400, json.dumps({"error": "bad_text"}).encode())
                    sess.text(s)
                elif kind in KEYS:
                    sess.key(kind)
                else:
                    return self._reply(400, json.dumps({"error": "bad_kind"}).encode())
            except Exception:
                return self._reply(502, json.dumps({"error": "input_failed"}).encode())
            return self._reply(200, json.dumps({"ok": True}).encode())
        return self._reply(404, json.dumps({"error": "not_found"}).encode())


def _num(body, name):
    try:
        v = float(body.get(name))
    except (TypeError, ValueError):
        raise ValueError(name)
    return max(0.0, min(1.0, v))


VIEWER_HTML = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Family-Link-Anmeldung</title>
<style>
:root{color-scheme:dark}
html,body{margin:0;background:#14161a;color:#e8eaed;font:15px/1.5 system-ui,sans-serif}
header{padding:10px 16px;border-bottom:1px solid #2a2e35}
#wrap{display:flex;flex-direction:column;align-items:center;padding:12px}
canvas{max-width:100%;height:auto;background:#000;border:1px solid #2a2e35;border-radius:8px;cursor:crosshair}
#hint{color:#9aa0a6;font-size:13px;margin:8px 0;text-align:center;max-width:720px}
#f{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
#t{background:#1d2026;color:#e8eaed;border:1px solid #3c4043;border-radius:6px;padding:9px;font-size:16px;width:min(560px,80vw)}
button{background:#1a73e8;border:0;color:#fff;border-radius:6px;padding:9px 14px;font-size:15px;cursor:pointer}
button.k{background:#3c4043}
</style>
</head>
<body>
<header id="status">Anmeldung läuft — Fenster schliesst automatisch, wenn Family Link geladen ist</header>
<div id="wrap">
<canvas id="c" width="1280" height="800"></canvas>
<p id="hint">Klicken und Scrollen wirkt direkt im Bild. Text unten eingeben und senden; Enter,
Backspace und Tab senden die echte Taste ins Browserfenster.</p>
<form id="f">
<input id="t" type="text" autocomplete="off" placeholder="Text eingeben (E-Mail, Passwort, OTP)">
<button type="submit">Senden</button>
<button type="button" class="k" id="kEnter">Enter</button>
<button type="button" class="k" id="kBack">Backspace</button>
<button type="button" class="k" id="kTab">Tab</button>
</form>
</div>
<script>
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("t") || "";
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var statusEl = document.getElementById("status");
  var input = document.getElementById("t");
  var img = new Image();
  var es = null;

  function post(payload) {
    fetch("/login/input?t=" + encodeURIComponent(token), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
  function draw(data, w, h) {
    img.onload = function () {
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
    };
    img.src = "data:image/jpeg;base64," + data;
  }
  function ended(state) {
    if (es) { es.close(); es = null; }
    if (state === "ok") {
      statusEl.textContent = "Angemeldet — Family Link ist geladen, Fenster kann geschlossen werden.";
      try { window.close(); } catch (e) { /* Popup-Blocker ist ok */ }
    } else if (state === "expired") {
      statusEl.textContent = "Sitzung abgelaufen — die Anmeldung wurde nicht fertig.";
    } else if (state === "cancelled") {
      statusEl.textContent = "Sitzung geschlossen.";
    } else {
      statusEl.textContent = "Verbindung zum Browser abgebrochen — bitte neu starten.";
    }
  }
  function open() {
    es = new EventSource("/login/stream?t=" + encodeURIComponent(token));
    es.onmessage = function (m) {
      var ev;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.type === "frame" && ev.data) { draw(ev.data, ev.w || 1280, ev.h || 800); }
      if (ev.type === "status" && ev.state !== "active") { ended(ev.state); }
    };
    es.onerror = function () { /* EventSource verbindet selbst neu, solange die Seite lebt */ };
  }
  function pt(e) {
    var r = canvas.getBoundingClientRect();
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
  }
  canvas.addEventListener("click", function (e) {
    var p = pt(e);
    post({ kind: "click", nx: p.nx, ny: p.ny });
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var p = pt(e);
    post({ kind: "wheel", nx: p.nx, ny: p.ny, dy: e.deltaY });
  }, { passive: false });
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = input.value;
    if (!v) { return; }
    post({ kind: "text", text: v });
    input.value = "";
  });
  document.getElementById("kEnter").addEventListener("click", function () { post({ kind: "Enter" }); });
  document.getElementById("kBack").addEventListener("click", function () { post({ kind: "Backspace" }); });
  document.getElementById("kTab").addEventListener("click", function () { post({ kind: "Tab" }); });
  open();
})();
</script>
</body>
</html>
"""


def main():
    port = int(os.environ.get("FAMILYLINK_LOGIN_PORT", "9334"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    sys.stderr.write("familylink_login_proxy: lauscht auf 0.0.0.0:%d\n" % port)
    srv.serve_forever()


if __name__ == "__main__":
    main()
