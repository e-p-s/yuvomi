#!/usr/bin/env python3
"""
familyhub_capture2.py — Login-Fänger für Google Family Link (kidsmanagement-API).

Persistentes headless Chromium (CDP :9333), Profil ~/.config/chromium-familyhub.
Nach erfolgreichem Login werden die Google-Session-Cookies (inkl. SAPISID,
__Secure-1PSIDTS) via CDP Network.getAllCookies exportiert →
~/.familyhub/session.json (0600). Daraus erzeugt familyhub_usage.py den
SAPISIDHASH zur Nutzung der kidsmanagement/v1-Endpunkte.

Commands:
  status     — chromium/login-Status
  state      — aktuelle Seite (URL, Felder, Buttons) [maskiert]
  email X    — E-Mail in das Identifier-Feld tippen + Continue
  secret     — verdeckte Eingabe (getpass) für Passwort/OTP ins aktive Feld
  click TXT  — Button klicken, dessen Text TXT (regex) matcht
  goto URL   — Navigation
  capture    — Cookies exportieren → session.json
"""
import json
import os
import secrets
import shutil
import socket
import struct as st
import subprocess
import sys
import time
import urllib.request
from getpass import getpass

PROFILE = os.path.expanduser("~/.config/chromium-familyhub")
SESSION_FILE = os.path.expanduser("~/.familyhub/session.json")
CDP = "http://127.0.0.1:9333"
FAMILY_URL = "https://familylink.google.com/"
LOGIN_URL = ("https://accounts.google.com/AccountChooser"
             "?continue=https://familylink.google.com/")


def cdp(path, method="GET"):
    req = urllib.request.Request(CDP + path, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def chromium_running():
    try:
        return "Browser" in cdp("/json/version")
    except Exception:
        return False


def ensure_chromium():
    if chromium_running():
        return
    os.makedirs(PROFILE, exist_ok=True)
    # Google blockiert Headless-Chromes bei der Anmeldung ("This browser or app
    # may not be secure", 2026-11-07 belegt — auch mit normaler Kennung).
    # Mit Xvfb laeuft ein echter Fenster-Browser ohne Bildschirm; ohne Xvfb
    # bleibt der Notbehelf headless (fuer reine Cookie-Erneuerung reicht er).
    xvfb = shutil.which("xvfb-run")
    if xvfb:
        argv = [xvfb, "-a", "--server-args=-screen 0 1280x1024x24", "/usr/bin/chromium"]
    else:
        argv = ["/usr/bin/chromium"]
    subprocess.Popen(
        argv +
        [
         "--user-data-dir=" + PROFILE,
         "--no-sandbox", "--disable-dev-shm-usage",
         "--no-first-run", "--disable-gpu",
         # Normale Chrome-Kennung + weggeschalteter Automations-Marker —
         # zusaetzlich zum echten Fenstermodus gegen Googles Blockseite.
         "--disable-blink-features=AutomationControlled",
         "--user-agent=" + NORMAL_UA,
         "--remote-debugging-port=9333", "--remote-debugging-address=127.0.0.1",
         "about:blank"],
        start_new_session=True,
        stdout=open("/tmp/familyhub-chrome.log", "ab"),
        stderr=subprocess.STDOUT,
    )
    for _ in range(30):
        if chromium_running():
            return
        time.sleep(1)
    raise SystemExit("chromium start failed")


NORMAL_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")


def chromium_flagged():
    """Laeuft ein Chromium, das sich als HeadlessChrome zu erkennen gibt?
    Dann wuerde Google die Anmeldung blockieren — es braucht einen Neustart
    mit normaler Kennung (ensure_chromium uebernimmt das)."""
    try:
        return "HeadlessChrome" in cdp("/json/version").get("Browser", "")
    except Exception:
        return False


def restart_if_flagged():
    """Headless-Kennung -> Profil-Chromium sanft beenden und mit normalem UA
    neu starten. Nur sinnvoll, wenn Xvfb einen echten Fenster-Browser erlaubt;
    ohne Xvfb blieb es sonst in einem Neustart-Kreislauf hängen."""
    if not chromium_running() or not chromium_flagged() or not shutil.which("xvfb-run"):
        return
    subprocess.call(["pkill", "-f", "--user-data-dir=" + PROFILE])
    for _ in range(10):
        if not chromium_running():
            break
        time.sleep(1)
    ensure_chromium()


def page_target():
    best = None
    for t in cdp("/json/list"):
        if t.get("type") != "page":
            continue
        u = t.get("url", "")
        if any(k in u for k in ("accounts.google", "familylink", "families")):
            return t
        best = best or t
    return best


def ensure_page(url):
    t = page_target()
    ws = WS(t["webSocketDebuggerUrl"]) if t else None
    if ws is None:
        t = cdp("/json/new?" + url, method="PUT")
        ws = WS(t["webSocketDebuggerUrl"])
    else:
        ws.call("Page.enable")
        cur = ws.call("Runtime.evaluate",
                      {"expression": "location.href", "returnByValue": True}
                      ).get("result", {}).get("result", {}).get("value", "")
        if "accounts.google" not in cur and "familylink" not in cur:
            ws.call("Page.navigate", {"url": url})
            time.sleep(4)
    return ws


class WS:
    def __init__(self, ws_url):
        assert ws_url.startswith("ws://")
        hostport, path = ws_url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=15)
        import base64
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.s.sendall((f"GET /{path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
                        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\n"
                        "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.s.recv(4096)
        self.i = 0
        self.s.settimeout(30)

    def _send(self, obj):
        payload = json.dumps(obj).encode()
        mask = secrets.token_bytes(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        hdr = b"\x81"
        n = len(payload)
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + st.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + st.pack(">Q", n)
        self.s.sendall(hdr + mask + masked)

    def _recv(self):
        hdr = self.s.recv(2)
        while len(hdr) < 2:
            hdr += self.s.recv(2 - len(hdr))
        n = hdr[1] & 0x7F
        if n == 126:
            n = st.unpack(">H", self.s.recv(2))[0]
        elif n == 127:
            n = st.unpack(">Q", self.s.recv(8))[0]
        data = b""
        while len(data) < n:
            chunk = self.s.recv(n - len(data))
            if not chunk:
                raise EOFError("ws closed")
            data += chunk
        return json.loads(data.decode())

    def call(self, method, params=None):
        self.i += 1
        my = self.i
        self._send({"id": my, "method": method, "params": params or {}})
        while True:
            m = self._recv()
            if m.get("id") == my:
                return m


JS_STATE = """
(() => {
  const fields = [...document.querySelectorAll('input')]
    .filter(i => i.type !== 'hidden')
    .map(i => ({type: i.type, id: i.id, aria: i.ariaLabel || ''}));
  const buttons = [...document.querySelectorAll('button')]
    .map(b => b.textContent.trim()).filter(Boolean).slice(0, 15);
  return {url: location.href, title: document.title, fields, buttons};
})()
"""

JS_FILL = """
((sel, txt) => {
  const inp = sel ? document.querySelector(sel)
    : document.querySelector('input[type="email"], input[type="tel"], '
      + 'input#identifier, input[type="text"]');
  if (!inp) return 'no-input';
  const set = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, txt);
  inp.dispatchEvent(new Event('input', {bubbles: true}));
  inp.dispatchEvent(new Event('change', {bubbles: true}));
  return 'filled:' + (inp.id || inp.type);
})(%s, %s)
"""

JS_CLICK = """
((txt) => {
  const re = new RegExp(txt, 'i');
  const cands = [...document.querySelectorAll('button, [role="button"]')]
    .filter(b => re.test(b.textContent.trim() || b.ariaLabel || ''));
  if (!cands.length) return 'no-match';
  const b = cands[cands.length - 1];
  b.click();
  return 'clicked:' + (b.textContent.trim() || b.ariaLabel);
})(%s)
"""


def ev(ws, expr):
    r = ws.call("Runtime.evaluate",
                {"expression": expr, "returnByValue": True})
    res = r.get("result", {})
    if "exceptionDetails" in res:
        return {"error": str(res["exceptionDetails"])[:200]}
    return res.get("result", {}).get("value")


def show_state(ws):
    time.sleep(2)
    print(json.dumps(ev(ws, JS_STATE), indent=1, ensure_ascii=False))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "state"
    ensure_chromium()

    if cmd == "status":
        print("chromium: running")
        t = page_target()
        print("page:", t["url"][:100] if t else "none")
        ws = WS(t["webSocketDebuggerUrl"])
        print("cookies:", len(get_all_cookies(ws)))
        sys.exit(0)

    if cmd == "capture":
        ws = ensure_page(FAMILY_URL)
        cookies = get_all_cookies(ws)
        os.makedirs(os.path.dirname(SESSION_FILE), exist_ok=True)
        with open(SESSION_FILE, "w") as f:
            json.dump({"exported": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                       "cookies": cookies}, f)
        os.chmod(SESSION_FILE, 0o600)
        names = sorted({c["name"] for c in cookies})
        need = {"SAPISID", "__Secure-1PSID", "__Secure-1PSIDTS"}
        print("cookies:", len(cookies), "→", SESSION_FILE)
        print("required present:", sorted(need & set(names)),
              "missing:", sorted(need - set(names)))
        sys.exit(0)

    if cmd == "goto":
        ws = ensure_page(FAMILY_URL)
        ws.call("Page.enable")
        ws.call("Page.navigate", {"url": sys.argv[2]})
        time.sleep(4)
        show_state(ws)
        return

    if cmd == "reload":
        ws = ensure_page(FAMILY_URL)
        ws.call("Page.enable")
        ws.call("Page.reload", {"ignoreCache": True})
        time.sleep(5)
        show_state(ws)
        return

    # interactive flow commands need the login page
    ws = ensure_page(LOGIN_URL)
    if cmd == "state":
        show_state(ws)
    elif cmd == "email":
        print(ev(ws, JS_FILL % ("null", json.dumps(sys.argv[2]))))
        time.sleep(1)
        print(ev(ws, JS_CLICK % json.dumps("weiter|next|weither|weiter")))
        show_state(ws)
    elif cmd == "secret":
        txt = getpass("Secret (Passwort/OTP, wird nicht angezeigt): ")
        sel = sys.argv[2] if len(sys.argv) > 2 else None
        print(ev(ws, JS_FILL % (json.dumps(sel), json.dumps(txt))))
        time.sleep(1)
        print(ev(ws, JS_CLICK % json.dumps("weiter|next|anmelden|einloggen")))
        show_state(ws)
    elif cmd == "click":
        print(ev(ws, JS_CLICK % json.dumps(sys.argv[2])))
        show_state(ws)
    elif cmd == "fill":
        print(ev(ws, JS_FILL % (json.dumps(sys.argv[2]), json.dumps(sys.argv[3]))))
        show_state(ws)
    else:
        raise SystemExit("unknown cmd: " + cmd)


def get_all_cookies(ws):
    r = ws.call("Network.enable")
    r = ws.call("Network.getAllCookies")
    return r.get("result", {}).get("cookies", [])


if __name__ == "__main__":
    main()
