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

Zusatzpfad — Auto-Ausfuellen (der Parent tippt E-Mail+Passwort nur in die App):
  POST /login/auto {email, password} oder {code} + Bearer
      -> 200 {result: "ok" | "otp_needed" | "bad_code" | "bad_password"
                             | "challenge" | "no_pending"}
  Der Auto-Pfad fuehrt eine pending-Login-Sitzung (In-Memory, TTL 10 Minuten,
  eine zugleich, parallel zur viewer-Sitzung moeglich): ueber CDP wird zur
  LOGIN_URL navigiert, das E-Mail-Feld gefuellt (input[type=email] bzw. erstes
  Textfeld), "Weiter" geklickt, das Passwortfeld nach Klick mit Input.insertText
  gefuellt (kein Passwort-Feld-Setzen per Skript-Lesezugriff), "Weiter". Danach
  Zustands-Erkennung (Poll bis 12s): familylink/families erreicht und nicht
  accounts.google -> Cookies exportieren (dieselbe Logik wie der capture-Befehl
  von familyhub_capture2.py) -> session.json, Report {"status":"ok"}, pending
  schliessen. OTP-Seite ohne mitgegebenen Code -> otp_needed (pending bleibt
  offen, die Seite steht auf OTP). Code mitgegeben -> ins Code-Feld tippen,
  Weiter, wieder Erkennung; bleibt die OTP-Seite stehen -> bad_code (Feld leer,
  code erneut erlaubt). "Falsches Passwort/Wrong password/Access denied" ->
  bad_password (pending schliessen, Seite auf about:blank). Captcha,
  Geraetebestaetigung, Kontenauswahl mit mehreren Konten -> challenge; die
  pending-Sitzung bleibt viewer-bar (das Viewer-System verwendet denselben
  Target — die App kann nahtlos ins Fenster wechseln).

Vertrag (Freigabe nur fuer den Yuvomi-Server; alle Antworten ohne Sitzungsdaten):
  POST /login/start   {session_token, expires_at} + Bearer  -> 200 {ok:true}
                      (eine Sitzung zur Zeit; eine zweite Start ersetzt die alte)
  POST /login/cancel  Bearer                                -> 200 {ok:true}
  GET  /login/view?t=<session_token>                        -> Viewer-Seite
  GET  /login/stream?t=<session_token>                      -> SSE (Frames + Status)
  POST /login/input?t=<session_token> {kind, ...}           -> 200 {ok:true}
  POST /login/auto  {email,password} | {code} + Bearer      -> 200 {result} (s.o.)
  GET  /health  (nur laeuft/was_laeuft, keine Daten)         -> 200 {ok, session, pending}
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
SIGNIN_URL = ("https://accounts.google.com/signin/v2/identifier"
              "?flowName=GlifWebSignIn&flowEntry=ServiceLogin"
              "&continue=https%3A%2F%2Ffamilylink.google.com%2F")
PUSH_TOKEN_FILE = os.path.expanduser("~/.familyhub/push_token")
# Debug-Schalter: existiert die Datei ~/.familyhub/debug, protokolliert der
# Auto-Login jeden Zustandswechsel (URL, Feldtypen, Konten, erster Textsatz —
# E-Mail masked, Passwoerter/Codes werden NIE gedruckt). Aus = aus.
DEBUG_FLAG = os.path.expanduser("~/.familyhub/debug")
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


def _debug_on():
    """Debug-Schalter = Existenz der Datei ~/.familyhub/debug (an/aus ohne
    Code-Aenderung; der Laeufer prueft bei jeder Zeile, ein Neustart ist
    nicht noetig)."""
    return os.path.exists(DEBUG_FLAG)


def _mask(text, masks):
    """Keine Eingaben im Log: jede in masks gegebene Zeichenkette (E-Mail,
    Code) wird aus text entfernt. Passwoerter erreichen das Log prinzipbedingt
    nie — sie werden nie als Text gehalten."""
    out = str(text or "")
    for m in masks:
        if m and len(m) >= 3:
            out = out.replace(m, "***")
    return out


def _probe_summary(dom, masks=()):
    """Einzeilige, sanitisierte Zusammenfassung einer Sondenerkennung — der
    Kern jeder Debug-Ausgabe und jeder Timeout-Meldung."""
    d = dom if isinstance(dom, dict) else {}
    types = sorted({(f.get("type") if isinstance(f, dict) else str(f)).lower()
                    for f in (d.get("fields") or [])})
    arias = sorted({_mask(f.get("aria") if isinstance(f, dict) else "", masks)
                    for f in (d.get("fields") or []) if isinstance(f, dict) and f.get("aria")})
    text = re.sub(r"\s+", " ", _mask(d.get("text") or "", masks))[:80]
    return (f"url={_mask(d.get('url') or '', masks)[:90]} felder={types} "
            f"aria={arias[:3]} konten={d.get('accounts')} text={text!r}")


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
# Auto-Ausfuellen: reine Zustands-Erkennung (ohne Chromium testbar)
# ══════════════════════════════════════════════════════════════════════════

# Kleinschreibung + Umlaute gefaltet: die Texte kommen von Google in beiden
# Schreibweisen (und die deutsche Seite schreibt "Bestätigen" wie "Bestaetigen").
# str.maketrans ist noetig: str.translate vergleicht Codepunkte, keine Strings.
_FOLD = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"})


def _fold(s):
    return str(s or "").lower().translate(_FOLD)


RE_BAD_PASSWORD = re.compile(
    r"falsches passwort|wrong password|access denied|passwort falsch|passwort ist falsch")
RE_CAPTCHA = re.compile(r"captcha|ich bin kein roboter|not a robot")
RE_OTP_TEXT = re.compile(
    r"bestaetigung|two-step|two step|authenticator|sicherheitscode|bestaetigungscode"
    r"|verifizierungscode|verification code|confirmation code")
# Geraetebestaetigung ("Ja, das bin ich" am Handy): KEIN Abbruch — ein Warten.
# Google schickt die Anfrage von selbst; ein Klick am Handy braucht Zeit, und
# nach 12s aufzugeben waere uebereilt (Nutzervorgabe 07.11.: laenger warten).
RE_DEVICE_CONFIRM = re.compile(
    r"bestaetigen sie|ist das ihr (geraet|tablet|handy)|confirm (this sign-in|it is you)"
    r"|diese anfrage bestaetigen|check your phone|auf ihrem (handy|geraet|telefon)"
    r"|pruefen sie ihr (handy|telefon|geraet)|google sent a notification")

# Zustands-Erkennung: diese vier Antworten beenden jeden Poll (Timeout -> challenge).
TERMINALS = ("success", "otp", "bad_password", "challenge")
# Geraetebestaetigung darf lange laufen: bis zu 150s auf den Klick am Handy.
PROMPT_WAIT_SECONDS = 150


def classify_page(url, dom):
    """Zustand der Google-Seite aus URL und DOM-Sondenergebnis (rein, ohne CDP).

    dom ist das Ergebnis von JS_AUTO_PROBE: {url, text, fields: [{type, aria}],
    accounts}. Akzeptiert der Einfachheit halber auch Felder als reine Typ-Strings.
    Rueckgabe: success | bad_password | challenge | otp | password | email | prompt | unknown.
    Reihenfolge: Erfolg, dann Fehlermeldungen (die Seite zeigt das Passwortfeld
    weiter, obwohl es schon verworfen ist), dann Kontenauswahl, dann Feldform."""
    u = _fold(url)
    d = dom if isinstance(dom, dict) else {}
    text = _fold(d.get("text"))
    types, arias = [], []
    for f in (d.get("fields") or []):
        if isinstance(f, str):
            types.append(f.lower())
            arias.append("")
        elif isinstance(f, dict):
            types.append(str(f.get("type") or "text").lower())
            arias.append(str(f.get("aria") or "").lower())
    has_pw = "password" in types
    has_email = "email" in types or any(("email" in a or "e-mail" in a) for a in arias)
    has_code_field = any(t in ("tel", "number") or "code" in a for t, a in zip(types, arias))
    # Erfolg: Family-Link-App geladen und nicht mehr auf accounts.google
    # (der continue-Parameter traegt familylink sonst in jede Login-URL).
    if ("familylink.google.com" in u or "families.google.com" in u) and "accounts.google" not in u:
        return "success"
    if RE_BAD_PASSWORD.search(text):
        return "bad_password"
    if RE_CAPTCHA.search(text):
        return "challenge"
    if RE_DEVICE_CONFIRM.search(text):
        # "Ja, das bin ich" am Handy — der Flow wartet darauf, kein Fenster.
        return "prompt"
    # Kontenauswahl mit mehreren Konten: ein Klick waere eine Entscheidung fuer
    # ein bestimmtes Konto — die trifft der Mensch im Viewer-Fenster.
    if "chooser" in u and int(d.get("accounts") or 0) >= 2:
        return "challenge"
    if has_pw:
        return "password"
    if has_email:
        return "email"
    if RE_OTP_TEXT.search(text) or has_code_field:
        return "otp"
    return "unknown"


# ══════════════════════════════════════════════════════════════════════════
# Auto-Ausfuellen: gefuehrte Feld-Eingaben ueber CDP (Werkzeuge aus capture2)
# ══════════════════════════════════════════════════════════════════════════

AUTO_TTL = 10 * 60  # eine pending-Login-Sitzung lebt 10 Minuten
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^\s@]{1,255}$")
CODE_RE = re.compile(r"^[0-9A-Za-z .\-]{4,16}$")

# Sonde fuer classify_page: URL, sichtbarer Text, sichtbare Felder, Kontenliste.
JS_AUTO_PROBE = """
(() => {
  const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const fields = [...document.querySelectorAll('input')]
    .filter(i => i.type !== 'hidden' && vis(i))
    .map(i => ({ type: (i.type || 'text').toLowerCase(),
                 aria: String(i.ariaLabel || i.name || i.id || '').toLowerCase() }));
  const text = ((document.body && document.body.innerText) || '').slice(0, 4000);
  const accounts = document.querySelectorAll('[data-email]').length;
  return { url: location.href, fields: fields, text: text, accounts: accounts };
})()
"""

# Mitte des ersten sichtbaren Felds zu diesem Selektor (Pixel, fuer den Klick
# vor Input.insertText — insertText schreibt nur in das, was den Fokus hat).
# Klick wie familyhub_capture2.JS_CLICK, aber zusaetzlich Links: Google baut
# "Anderen Weg versuchen" als Link, nicht als Knopf.
JS_CLICK_WIDE = """
((txt) => {
  const re = new RegExp(txt, 'i');
  const cands = [...document.querySelectorAll('button, [role="button"], a')]
    .filter(b => (b.offsetWidth || b.offsetHeight || b.getClientRects().length)
                 && re.test((b.textContent.trim() || '') + ' ' + (b.ariaLabel || '')));
  if (!cands.length) return 'no-match';
  const b = cands[cands.length - 1];
  b.click();
  return 'clicked:' + (b.textContent.trim() || b.ariaLabel || '').slice(0, 60);
})(%s)
"""

# Sichtbare Methode-Texte der Auswahlseite (Diagnose + Klickgrundlage): Google
# bietet die Wege als LI-Liste mit jsaction an, nicht als Knopf (17:37-Befund).
JS_OPTIONS = """
(() => [...document.querySelectorAll('li, [role="listitem"], button, [role="button"], a')]
  .filter(b => b.offsetWidth || b.offsetHeight || b.getClientRects().length)
  .map(b => ((b.textContent.trim() || b.ariaLabel || '').replace(/\\s+/g, ' ').slice(0, 70)))
  .filter(t => t).slice(0, 14))()
"""

# Mitte des ersten sichtbaren Methoden-Eintrags — goegter Klick noetig:
# ein DOM-click() auf der LI-Liste verpufft bei Googles jsaction-Delegation
# (Live-Test 17:50: nur echte Maeuse-Events offnen die Prompt-Seite).
JS_OPTION_CENTER = """
((txt) => {
  const re = new RegExp(txt, 'i');
  const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const items = [...document.querySelectorAll('li, [role="listitem"], button, [role="button"], a')]
    .filter(el => vis(el) && re.test((el.textContent || '').trim()));
  if (!items.length) return null;
  const r = items[0].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})(%s)
"""

# Google-Texte der Weg-Umschaltung (deutsch/englisch, ohne Umlaute gemischt).
RE_TRY_OTHER = "anderen weg|anderer weg|try another way|anderweitig"
RE_PROMPT_OPTION = r"tap ?yes|(tippen|tappe).*(ja|yes)|prompt|aufforderung"

JS_FIELD_CENTER = """
((sel) => {
  const els = [...document.querySelectorAll(sel)]
    .filter(i => i.type !== 'hidden' && (i.offsetWidth || i.offsetHeight || i.getClientRects().length));
  if (!els.length) return null;
  const r = els[0].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})(%s)
"""

# Code-Feld der OTP-Seite: tel/number/text, aber weder E-Mail noch Passwort.
JS_CODE_CENTER = """
(() => {
  const els = [...document.querySelectorAll('input')].filter(i => {
    if (i.type === 'hidden' || i.type === 'password' || i.type === 'email') return false;
    if (!(i.offsetWidth || i.offsetHeight || i.getClientRects().length)) return false;
    const t = (i.type || 'text').toLowerCase();
    const a = String(i.ariaLabel || i.name || i.id || '').toLowerCase();
    return t === 'tel' || t === 'number' || t === 'text' || a.includes('code');
  });
  if (!els.length) return null;
  const r = els[0].getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()
"""

JS_CODE_CLEAR = """
(() => {
  const els = [...document.querySelectorAll('input')].filter(i => {
    if (i.type === 'hidden' || i.type === 'password' || i.type === 'email') return false;
    const t = (i.type || 'text').toLowerCase();
    const a = String(i.ariaLabel || i.name || i.id || '').toLowerCase();
    return t === 'tel' || t === 'number' || t === 'text' || a.includes('code');
  });
  if (!els.length) return 'none';
  const set = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  set.call(els[0], '');
  els[0].dispatchEvent(new Event('input', { bubbles: true }));
  return 'cleared';
})()
"""

_auto_lock = threading.Lock()
_pending = None  # {'state': 'otp'|'challenge', 'expiry': epoch} oder None
_last_email = None  # nur als Mask fuer Logzeilen, nie Log-Inhalt


def pending_state():
    """Der pending-Zustand fuer /health: null | 'otp' | 'challenge' (abgelaufene
    Sitzung wird hier faellig — eine GET-Antwort luegt nie ueber eine tote pending)."""
    global _pending
    with _auto_lock:
        if _pending is None:
            return None
        if time.time() > _pending["expiry"]:
            _pending = None
            return None
        return _pending["state"]


def _open_pending(state):
    """Pending anlegen/verlaengern (eine zugleich — die Regel des Auftrags)."""
    global _pending
    _pending = {"state": state, "expiry": time.time() + AUTO_TTL}


def _attach_ws(navigate=False):
    """Eigene WS-Verbindung zum Page-Target (der Viewer hat seine eigene — zwei
    Verbindungen an einem Target sind in CDP üblich). navigate=URL: fährt diese
    Seite erst an (der Auto-Pfad startet immer bei Null — auch wenn die Seite
    schon auf familylink steht und ensure_page sonst nicht navigieren würde).
    Vorher: blockiert die Headless-Kennung Google, startet der Browser mit
    normaler Kennung neu (familyhub_capture2.restart_if_flagged)."""
    cap.restart_if_flagged()
    cap.ensure_chromium()
    t = cap.page_target()
    if t is None:
        t = cap.cdp("/json/new?" + urllib.parse.quote(navigate or cap.LOGIN_URL, safe=":/?=&%"), method="PUT")
        ws = cap.WS(t["webSocketDebuggerUrl"])
    else:
        ws = cap.WS(t["webSocketDebuggerUrl"])
    ws.call("Page.enable")
    if navigate:
        ws.call("Page.navigate", {"url": navigate})
        time.sleep(1.5)
    return ws


def _probe(ws):
    dom = cap.ev(ws, JS_AUTO_PROBE)
    return dom if isinstance(dom, dict) else {}


def _dbg(msg):
    """Debug-Zeile nur, wenn der Schalter (~/.familyhub/debug) gesetzt ist."""
    if _debug_on():
        print(f"[login-flow] {time.strftime('%H:%M:%S')} {msg}", flush=True)


def _dbg_always(msg):
    """Zeile, die auch ohne Schalter bleibt (seltene, sanitisierte Endmeldung)."""
    print(f"[login-flow] {time.strftime('%H:%M:%S')} {msg}", flush=True)


def _wait_for(ws, wanted, timeout, masks=()):
    """Poll (0.8s) bis ein gewuenschter Zustand erreicht ist; 'timeout' sonst.
    Mit Debug-Schalter wird jeder Wechsel protokolliert; ein Timeout druckt die
    Sonde immer (sanisiert — masks enthaelt die Eingaben, die nicht erscheinen
    dürfen). Das ist der Weg, warum ein Lauf stecken blieb, ohne dass man
    Passwoerter loggen muss."""
    end = time.time() + timeout
    last = None
    while True:
        dom = _probe(ws)
        st = classify_page(dom.get("url") or "", dom)
        if st != last:
            _dbg(f"Zustand {last} -> {st} | {_probe_summary(dom, masks)}")
            last = st
        if st in wanted:
            return st
        if time.time() >= end:
            _dbg_always(f"Zustands-Timeout nach {timeout}s | {_probe_summary(dom, masks)}")
            return "timeout"
        time.sleep(0.8)


def _press(ws, name):
    """Eine der drei hinterlegten Tasten (Enter/Backspace/Tab) echt druecken."""
    k = KEYS[name]
    ws.call("Input.dispatchKeyEvent", {"type": "keyDown", **{x: k[x] for x in k if x != "text"}})
    if "text" in k:
        ws.call("Input.dispatchKeyEvent", {"type": "keyDown", "text": k["text"], "key": k["key"], "code": k["code"]})
    ws.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": k["key"], "code": k["code"]})


def _click_xy(ws, x, y):
    base = {"x": int(x), "y": int(y), "button": "left", "clickCount": 1}
    ws.call("Input.dispatchMouseEvent", dict(base, type="mousePressed"))
    ws.call("Input.dispatchMouseEvent", dict(base, type="mouseReleased"))


def _finish_ok(ws):
    """Erfolg: Cookies exportieren (dieselbe Logik wie capture2.capture), Report
    'ok' wie bisher, pending schliessen, getippte Daten nicht stehen lassen.
    Scheitert der Export, bleibt die pending offen — der Viewer-Pfad kann
    fertig werden, und ein 'ok' ohne frische session.json waere eine Falsaussage."""
    global _pending
    try:
        cookies = cap.get_all_cookies(ws)
        write_session_json(cookies)
        report_status("ok")
    except Exception:
        return "challenge"
    _pending = None
    return "ok"


def _finish_bad_password(ws):
    """Pending schliessen, Seite auf about:blank (das getippte Passwort bleibt
    nicht stehen); ein neuer Versuch braucht E-Mail+Passwort von der App."""
    global _pending
    _pending = None
    try:
        ws.call("Page.navigate", {"url": "about:blank"})
    except Exception:
        pass
    return "bad_password"


def _switch_to_prompt(ws, masks=()):
    """Von der Code-Seite zur Handy-Bestaetigung ("Ja, das bin ich") wechseln.

    Google zeigt die Geraete-Prompt-Seite fast nie direkt an, aber unter
    "Anderen Weg versuchen" steht sie bereit ("Eingabeaufforderung an Ihr
    Handy senden" / "Show prompt on your phone"). Zwei Klicks mit kurzem
    Nachwarten; nach dem ersten Klick zaehlt 'otp' nicht als Ende (die
    Optionsseite nennt Bestaetigungswege), erst nach dem zweiten gibt der
    gefundene Zustand zurueck. Misslingt der Schalter, kommt 'none'."""
    # Schritt 1: "Anderen Weg versuchen" (Link auf der Code-Seite).
    try:
        r = cap.ev(ws, JS_CLICK_WIDE % json.dumps(RE_TRY_OTHER))
    except Exception:
        return "none"
    _dbg(f"Prompt-Schalter (Weg wechseln): {r}")
    if not (isinstance(r, str) and r.startswith("clicked")):
        return "none"
    st = _wait_for(ws, ("prompt", "success", "bad_password", "challenge"), 6, masks)
    if st in ("prompt", "success", "bad_password", "challenge"):
        return st
    # Schritt 2: Die Auswahlseite ist eine SPA — die Knopfleiste erscheint
    # erst nach einigen Sekunden (17:33-Befund: Klick nach 4s = no-match,
    # Seite noch "Loading"). Also auf Knöpfe warten und sie protokollieren.
    pat = re.compile(RE_PROMPT_OPTION, re.I)
    seen = []
    for _ in range(12):
        btns = cap.ev(ws, JS_OPTIONS)
        btns = [str(b) for b in btns] if isinstance(btns, list) else []
        if btns != seen:
            seen = btns
            _dbg("Auswahlseiten-Knöpfe: " + " | ".join(_mask(b, masks) for b in btns))
        hit = next((b for b in btns if pat.search(b)), None)
        if hit:
            c = cap.ev(ws, JS_OPTION_CENTER % json.dumps(RE_PROMPT_OPTION))
            if isinstance(c, dict) and "x" in c:
                _click_xy(ws, c["x"], c["y"])
                _dbg(f"Prompt-Schalter (Handy-Prompt): geklickt (Text: {_mask(hit, masks)})")
            # 'otp' hier bewusst NICHT gewollt: die Auswahlseite nennt auch
            # Codes und waere sonst sofort Terminal (17:43-Befund: Abbruch
            # mitten im Uebergang, obwohl der Prompt laengst rausging).
            st = _wait_for(ws, ("prompt", "success", "bad_password", "challenge"), 20, masks)
            return st if st in ("prompt", "success", "bad_password", "challenge") else "none"
        time.sleep(1.0)
    _dbg_always("Kein Handy-Prompt unter den Google-Wegen — Code-Eingabe bleibt.")
    return "none"


def _load_media():
    """familyhub_media.py aus demselben Verzeichnis (Template-Pfade/Parser)."""
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(cap.__file__)), "familyhub_media.py")
    spec = importlib.util.spec_from_file_location("famhub_media", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _capture_usage_async():
    threading.Thread(target=_capture_usage, daemon=True).start()


def _capture_usage():
    """Nach Login-Erfolg: die exakten appsAndUsage-URLs pro Kind abhoeren (A2).
    Googles API antwortet nur auf URLs, die ein echter Seitenbesuch erzeugt hat
    (Umformung = 404, verifiziert 07.11.) — die Vorlage muss im eingelogten
    Browser entstehen, genau jetzt. Laeuft im Hintergrund und ist still:
    ohne Fang gilt weiter der Tageswerte-Pfad."""
    try:
        med = _load_media()
        t = cap.page_target()
        if t is None:
            return
        ws = cap.WS(t["webSocketDebuggerUrl"])
        ws.call("Page.enable")
        sid = {c["name"]: c["value"] for c in cap.get_all_cookies(ws)
               if c["domain"] == ".google.com"}.get("SAPISID")
        if not sid:
            _dbg("Usage-Fang: kein SAPISID — uebersprungen")
            return
        mtpl = json.load(open(med.tpl_path("members")))
        kids = [k for k in med.members(mtpl, sid) if k["supervised"]]
        for k in kids:
            uid = k["userId"]
            if os.path.exists(med.tpl_path("appsandusage_" + uid)):
                _dbg(f"Usage-Fang {uid}: Vorlage vorhanden")
                continue
            got = _capture_usage_uid(ws, med, uid)
            _dbg(f"Usage-Fang {uid}: {'ok' if got else 'leer'}")
    except Exception as e:
        _dbg(f"Usage-Fang fehlgeschlagen: {type(e).__name__}")


def _capture_usage_uid(ws, med, uid):
    """Member-Seite ansteuern (und notfalls im Menue 'Screen time' klicken)
    und die usage-URL fangen; Rueckgabe: URL oder None."""
    ws.call("Fetch.enable", {"patterns": [
        {"urlPattern": "*kidsmanagement*", "requestStage": "Request"}]})
    try:
        ws.call("Page.navigate", {"url": f"https://familylink.google.com/member/{uid}/screenTime"})
        got = _drain_usage(ws, med, uid, 20)
        if got is None:
            c = cap.ev(ws, JS_OPTION_CENTER % json.dumps("screen ?time"))
            if isinstance(c, dict) and "x" in c:
                _click_xy(ws, c["x"], c["y"])
                got = _drain_usage(ws, med, uid, 20)
        return got
    finally:
        try:
            ws.call("Fetch.disable")
        except Exception:
            pass


def _drain_usage(ws, med, uid, seconds):
    """Faengt den kidsmanagement-Request mit 'usage' im Pfad; speichert die
    Vorlage pro Kind (+ generisch, letztes Kind gewinnt — media.py nutzt sie)."""
    t0 = time.time()
    ws.s.settimeout(seconds)
    while time.time() - t0 < seconds:
        try:
            m = ws._recv()
        except Exception:
            return None
        if m.get("method") != "Fetch.requestPaused":
            continue
        p = m["params"]
        req = p["request"]
        ws.call("Fetch.continueRequest", {"requestId": p["requestId"]})
        u = req["url"]
        pfad = u.split("kidsmanagement")[-1].split("?")[0].lower()
        if "usage" in pfad and req.get("headers", {}).get("Cookie"):
            tpl = {"url": u, "headers": req["headers"], "uid": uid,
                   "saved": time.strftime("%Y-%m-%dT%H:%M:%S")}
            for name in (f"appsandusage_{uid}", "appsandusage"):
                with open(med.tpl_path(name), "w") as f:
                    json.dump(tpl, f, indent=1)
                os.chmod(med.tpl_path(name), 0o600)
            return u
    return None


def _dispatch_terminal(ws, st, tried_prompt=False):
    """Eine Terminal-Erkenntnis in die Auto-Antwort uebersetzen."""
    if st == "success":
        out = _finish_ok(ws)
        if out == "ok":
            _capture_usage_async()
        return out
    if st == "bad_password":
        return _finish_bad_password(ws)
    if st == "otp":
        # Nutzer will das Tippen am Handy ("Ja, das bin ich"), nicht SMS.
        # Erster Versuch: von der Code-Seite dorthin umschalten — gelingt das,
        # wird bis PROMPT_WAIT_SECONDS auf den Klick gewartet.
        if not tried_prompt:
            sw = _switch_to_prompt(ws, (_last_email,))
            if sw == "prompt":
                return _dispatch_terminal(ws, _await_prompt(ws, "prompt"))
            if sw in TERMINALS and sw != "otp":
                return _dispatch_terminal(ws, sw)
            # sonst: Code-Weg durchspielen — aber nie erneut umschalten.
            return _dispatch_terminal(ws, "otp", tried_prompt=True)
        # "Get a code to sign in" liefert den Code oft erst nach einem Klick
        # ("Send"/"An Ihr Handy senden"/"Weiter") — ohne ihn kaeme nichts am
        # Handy an. Fehlender Knopf ist ungefaehrlich (kein Treffer, kein Klick).
        try:
            cap.ev(ws, cap.JS_CLICK % json.dumps("senden|send|an ihr handy|sms|text|weiter|next"))
        except Exception:
            pass
        time.sleep(0.5)
        _open_pending("otp")
        return "otp_needed"
    # challenge und alles Unklare: pending bleibt offen und viewer-bar —
    # die App kann nahtlos ins Fenster wechseln (Viewer nutzt denselben Target).
    _open_pending("challenge")
    return "challenge"


def _await_prompt(ws, st, masks=()):
    """'prompt' = Google wartet auf den Klick am Handy ("Ja, das bin ich").
    Kein Fenster, kein Abbruch: nachwarten bis PROMPT_WAIT_SECONDS."""
    if st != "prompt":
        return st
    _dbg_always("Geruete-Bestaetigung offen — warte bis zu %ds auf den Klick am Handy" % PROMPT_WAIT_SECONDS)
    return _wait_for(ws, TERMINALS, PROMPT_WAIT_SECONDS, masks)


def _run_login_flow(email, password):
    global _pending
    _pending = None
    global _last_email
    _last_email = email or None
    masks = (email,)
    _dbg(f"Auto-Login startet (Konto {_mask(email, masks)})")
    ws = _attach_ws(navigate=SIGNIN_URL)
    try:
        st = _await_prompt(ws, _wait_for(ws, ("email", "password", "otp", "prompt", "success", "bad_password", "challenge"), 12, masks), masks)
        if st == "timeout":
            # Haufigster Blindflug: das Profil ist bei Google noch angemeldet und
            # die Seite zeigt die Kontenauswahl. Ein Konto -> wir klicken es und
            # warten erneut; zwei oder mehr -> Entscheidung, die ein Mensch
            # im Fenster trifft (challenge).
            dom = _probe(ws)
            url = dom.get("url") or ""
            n = int(dom.get("accounts") or 0)
            if "chooser" in url and n >= 1:
                _dbg(f"Kontenauswahl mit {n} Konto(n)")
                if n >= 2:
                    return _dispatch_terminal(ws, "challenge")
                c = cap.ev(ws, JS_FIELD_CENTER % json.dumps("[data-email]"))
                if isinstance(c, dict) and "x" in c:
                    _click_xy(ws, c["x"], c["y"])
                    st = _await_prompt(ws, _wait_for(ws, ("email", "password", "otp", "prompt", "success", "bad_password", "challenge"), 12, masks), masks)
        if st == "email":
            cap.ev(ws, cap.JS_FILL % ("null", json.dumps(email)))
            time.sleep(0.6)
            cap.ev(ws, cap.JS_CLICK % json.dumps("weiter|next"))
            st = _await_prompt(ws, _wait_for(ws, ("password", "otp", "prompt", "success", "bad_password", "challenge"), 12, masks), masks)
        if st not in ("password", "otp", "success", "bad_password", "challenge"):
            _dbg_always(f"unklarer Zustand nach Vorlauf ({st}) — Viewer uebernimmt")
            return _dispatch_terminal(ws, "challenge")  # timeout/unklar: manuell weiter
        if st == "password":
            # Vorgabe: Input.insertText ERST nach dem Klick aufs Feld — sonst
            # landet der Text nirgends. Kein Skript-Lesen am Passwortfeld.
            c = cap.ev(ws, JS_FIELD_CENTER % json.dumps('input[type="password"]'))
            if isinstance(c, dict) and "x" in c:
                _click_xy(ws, c["x"], c["y"])
                time.sleep(0.15)
                ws.call("Input.insertText", {"text": password})
            else:
                cap.ev(ws, cap.JS_FILL % (json.dumps('input[type="password"]'), json.dumps(password)))
            time.sleep(0.6)
            cap.ev(ws, cap.JS_CLICK % json.dumps("weiter|next|anmelden|einloggen"))
            # Googles Formular reagiert nicht immer auf den Klick allein — ein
            # Enter ins Feld ist derselbe Absender (13:32-Befund: Seite blieb
            # nach Klick stehen). Und die SPA braucht gern mal >12s.
            st = _wait_for(ws, TERMINALS + ("prompt",), 3, masks)
            if st not in TERMINALS and st != "prompt":
                c = cap.ev(ws, JS_FIELD_CENTER % json.dumps('input[type="password"]'))
                if isinstance(c, dict) and "x" in c:
                    _click_xy(ws, c["x"], c["y"])
                    time.sleep(0.1)
                _press(ws, "Enter")
                st = _await_prompt(ws, _wait_for(ws, TERMINALS + ("prompt",), 20, masks), masks)
            else:
                st = _await_prompt(ws, st, masks)
        return _dispatch_terminal(ws, st if st in TERMINALS else "challenge")
    finally:
        try:
            ws.s.close()
        except Exception:
            pass


def _run_code_flow(code):
    masks = (_last_email,)  # E-Mail taucht im Seitentext auf — nie ins Log
    ws = _attach_ws(navigate=False)  # die Seite steht auf OTP — nicht wegnavigieren
    try:
        dom = _probe(ws)
        st = classify_page(dom.get("url") or "", dom)
        _dbg(f"Code-Lauf startet, Zustand {st} | {_probe_summary(dom, masks)}")
        if st in ("success", "bad_password", "challenge"):
            return _dispatch_terminal(ws, st)
        c = cap.ev(ws, JS_CODE_CENTER)
        if not isinstance(c, dict) or "x" not in c:
            _open_pending("otp")
            return "bad_code"  # kein Feld: code erneut erlaubt
        _click_xy(ws, c["x"], c["y"])
        time.sleep(0.15)
        ws.call("Input.insertText", {"text": code})
        time.sleep(0.6)
        cap.ev(ws, cap.JS_CLICK % json.dumps("weiter|next"))
        st = _await_prompt(ws, _wait_for(ws, TERMINALS + ("prompt",), 12, masks), masks)
        if st == "success":
            return _finish_ok(ws)
        if st in ("bad_password", "challenge"):
            return _dispatch_terminal(ws, st)
        # OTP-Seite bleibt stehen (oder nichts Neues): falsch/zu frueh — Feld
        # leer zurueck, code ist erneut erlaubt (pending bleibt auf 'otp').
        cap.ev(ws, JS_CODE_CLEAR)
        _open_pending("otp")
        return "bad_code"
    finally:
        try:
            ws.s.close()
        except Exception:
            pass


def auto_login(email, password, code):
    """Ein Auto-Login-Schritt (unter der Auto-Lock, damit nie zwei Fluesse am
    selben Target tippen). Gibt zurueck: ok | otp_needed | bad_code |
    bad_password | challenge | no_pending. NIE Passwoerter oder Codes."""
    with _auto_lock:
        global _pending
        if _pending is not None and time.time() > _pending["expiry"]:
            _pending = None
        if code is not None and email is None:
            if _pending is None:
                return "no_pending"
            return _run_code_flow(code)
        return _run_login_flow(email, password)


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
            return self._reply(200, json.dumps({
                "ok": True,
                "session": active_session() is not None,
                "pending": pending_state(),
            }).encode())
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
        if u.path == "/login/auto":
            if not self._authed():
                return self._reply(401, json.dumps({"error": "unauthorized"}).encode())
            body = self._json_in()
            if not isinstance(body, dict):
                return self._reply(400, json.dumps({"error": "bad_body"}).encode())
            email = body.get("email")
            password = body.get("password")
            code = body.get("code")
            # Validierung vor jedem Zugriff: Form/laenge, NIE der Inhalt. Ein
            # Code-Feld wird erst im Flow angefasst; Fehlermeldungen tragen hier
            # nur die Feldbezeichnung.
            if email is not None and not (isinstance(email, str) and EMAIL_RE.match(email)):
                return self._reply(400, json.dumps({"error": "bad_email"}).encode())
            if password is not None and not (isinstance(password, str) and 0 < len(password) <= 300):
                return self._reply(400, json.dumps({"error": "bad_password_field"}).encode())
            if code is not None and not (isinstance(code, str) and CODE_RE.match(code)):
                return self._reply(400, json.dumps({"error": "bad_code_field"}).encode())
            try:
                if code is not None and email is None and password is None:
                    result = auto_login(None, None, code)
                elif email is not None and password is not None:
                    result = auto_login(email, password, None)
                else:
                    return self._reply(400, json.dumps({"error": "bad_body"}).encode())
            except Exception as e:
                # Kein Grundtext hierher — er koennte Seiten-URLs tragen; die
                # Art steht im Log (Methode und Pfad ohne Query), Daten nie.
                sys.stderr.write("login/auto:FLOW fehlgeschlagen %s\n" % type(e).__name__)
                return self._reply(500, json.dumps({"error": "auto_failed"}).encode())
            return self._reply(200, json.dumps({"result": result}).encode())
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
