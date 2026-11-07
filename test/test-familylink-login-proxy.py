#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test: reine Logik des Fernlogin-Beistands (scripts/familylink/familylink_login_proxy.py).
Zweck: Tokenvergleich, Bearer-Pruefung und TTL-Begrenzung sind die sicherheits-
kritischen Pure Functions des Dienstes — sie laufen ohne Chromium und ohne
Netz. Der Chromium-Pfad selbst ist hier bewusst nicht geprueft (dafuer laeuft
der Dienst auf dem Sammler); der Test ueberspringt sich, wenn das Modul den
Capture-Import nicht durchfaehrt.
Ausfuehren: python3 test/test-familylink-login-proxy.py
"""

import importlib.util
import os
import pathlib
import sys
import time

PROXY = pathlib.Path(__file__).resolve().parent.parent / \
    "scripts" / "familylink" / "familylink_login_proxy.py"
os.environ.setdefault("FAMILYHUB_SCRIPT_DIR", str(PROXY.parent))

try:
    _spec = importlib.util.spec_from_file_location("flp", str(PROXY))
    flp = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(flp)
except Exception as exc:  # pragma: no cover - Umgebung ohne Capture-Modul
    print("SKIP: Proxy-Modul nicht ladbar:", exc)
    sys.exit(0)

failures = []
checks = [0]


def check(name, cond):
    checks[0] += 1
    if not cond:
        failures.append(name)


# — Bearer / Tokenvergleich (zeitkonstant, leer gilt nie) ————————————————
check("bearer ok", flp.bearer_ok("Bearer abc123", "abc123"))
check("bearer falsch", not flp.bearer_ok("Bearer falsch", "abc123"))
check("bearer ohne Header", not flp.bearer_ok(None, "abc123"))
check("bearer ohne Geheimnis", not flp.bearer_ok("Bearer abc123", None))
check("bearer ohne Schema", not flp.bearer_ok("abc123", "abc123"))
check("token ok", flp.token_ok("a" * 64, "a" * 64))
check("token falsch", not flp.token_ok("a" * 63 + "b", "a" * 64))
check("token leer gegen Satz", not flp.token_ok("", "a" * 64))
check("token None sicher", not flp.token_ok(None, "a" * 64))

# — TTL: harte Obergrenze 15 Minuten, Vergangenes ist ungueltig ——————————
now = 1_800_000_000.0
far = flp.parse_expiry("2099-01-01T00:00:00Z", now=now)
check("TTL auf 15 Minuten begrenzt", abs(far - (now + flp.HARD_MAX_TTL)) < 1.0)
near = flp.parse_expiry(time.strftime(
    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + 300)), now=now)
check("TTL unter der Grenze bleibt stehen", abs(near - (now + 300)) < 2.0)
try:
    flp.parse_expiry("2000-01-01T00:00:00Z", now=now)
    check("vergangene Frist wirft", False)
except ValueError:
    check("vergangene Frist wirft", True)
for bad in (None, "", "morgen"):
    try:
        flp.parse_expiry(bad, now=now)
        check("ungueltige Frist (%r) wirft" % (bad,), False)
    except (ValueError, TypeError):
        check("ungueltige Frist (%r) wirft" % (bad,), True)

# — Token-Format der App-Seite (32 Byte hex) -------------------------------
import re  # noqa: E402
check("Token-Regel akzeptiert 64 hex", bool(flp.TOKEN_RE.match("0" * 64)))
check("Token-Regel lehnt kurz ab", not flp.TOKEN_RE.match("deadbeef"))
check("Token-Regel lehnt Nicht-hex ab", not flp.TOKEN_RE.match("z" * 64))

# ════════════════════════════════════════════════════════════════════════════
# Zustands-Erkennung des Auto-Logins (classify_page — rein, ohne Chromium)
# ════════════════════════════════════════════════════════════════════════════

SIGNIN = "https://accounts.google.com/signin/challenge/sl/password"

# Erfolg: Family-Link-App erreicht und nicht mehr auf accounts.google.
check("Erfolg auf familylink",
      flp.classify_page("https://familylink.google.com/", {"fields": []}) == "success")
check("Erfolg auf families",
      flp.classify_page("https://families.google.com/families", None) == "success")
# Der continue-Parameter traegt familylink in jede Login-URL — kein Erfolg.
check("continue-URL ist kein Erfolg",
      flp.classify_page("https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Ffamilylink.google.com%2F",
                        {"fields": [{"type": "email"}]}) != "success")

# Passwortfehler (beide Sprachen,Spec-Formulierungen).
for msg in ("Falsches Passwort.", "Wrong password.", "Access denied"):
    check("bad_password: %s" % msg,
          flp.classify_page(SIGNIN, {"text": msg, "fields": [{"type": "password"}]}) == "bad_password")

# Nicht automatisierbar: captcha / 'Ich bin kein Roboter' / Geraetebestaetigung.
check("challenge captcha",
      flp.classify_page(SIGNIN, {"text": "Bitte geben Sie die Zeichen im Captcha ein",
                                 "fields": []}) == "challenge")
check("challenge Roboter deutsch",
      flp.classify_page(SIGNIN, {"text": "Ich bin kein Roboter", "fields": []}) == "challenge")
check("challenge Geraetebestaetigung vor OTP-Text",
      flp.classify_page(SIGNIN, {"text": "Bestätigen Sie, dass Sie sich anmelden möchten",
                                 "fields": [{"type": "tel"}]}) == "challenge")
# Kontenauswahl: erst ab zwei Konten eine Entscheidung fuer den Menschen.
check("challenge Kontenauswahl (2 Konten)",
      flp.classify_page("https://accounts.google.com/AccountChooser",
                        {"accounts": 2, "fields": []}) == "challenge")
check("Kontenauswahl mit einem Konto ist keine Entscheidung",
      flp.classify_page("https://accounts.google.com/AccountChooser",
                        {"accounts": 1, "fields": [{"type": "email"}]}) == "email")

# OTP-Seite: Text (Bestaetigung/Two-step/Authenticator) und/oder Code-Feld.
check("otp Bestaetigungscode",
      flp.classify_page(SIGNIN, {"text": "Geben Sie zur Bestätigung Ihren Code ein",
                                 "fields": [{"type": "tel", "aria": "eingabecode"}]}) == "otp")
check("otp two-step",
      flp.classify_page(SIGNIN, {"text": "Two-Step Verification", "fields": [{"type": "text"}]}) == "otp")
check("otp Authenticator",
      flp.classify_page(SIGNIN, {"text": "Authenticator-Code", "fields": []}) == "otp")

# Feldformen: Passwortseite vor OTP-Text, E-Mailseite als email, sonst unknown.
check("Feld password",
      flp.classify_page(SIGNIN, {"fields": [{"type": "password"}]}) == "password")
check("Feld email",
      flp.classify_page(SIGNIN, {"fields": [{"type": "email", "aria": "e-mail"}]}) == "email")
check("Feld tel mit email-aria bleibt email",
      flp.classify_page(SIGNIN, {"fields": [{"type": "tel", "aria": "email"}]}) == "email")
check("leere Seite unknown", flp.classify_page(SIGNIN, {"fields": []}) == "unknown")
check("Felder als reine Typ-Strings akzeptiert",
      flp.classify_page(SIGNIN, {"fields": ["password"]}) == "password")

# Terminals sind die vier Auto-Antworten (der Poll endet spaetestens damit).
check("Terminals vollständig",
      set(flp.TERMINALS) == {"success", "otp", "bad_password", "challenge"})

# pending-Zustand fuer /health: null | 'otp' | 'challenge' (TTLfaellig -> null).
flp._pending = None
check("pending ohne Sitzung null", flp.pending_state() is None)
flp._open_pending("otp")
check("pending otp", flp.pending_state() == "otp")
flp._pending["expiry"] = time.time() - 1
check("pending abgelaufen -> null", flp.pending_state() is None)

if failures:
    print("FAIL:", "; ".join(failures))
    sys.exit(1)
print("OK: familylink_login_proxy Logik (%d Pruefungen)" % checks[0])
