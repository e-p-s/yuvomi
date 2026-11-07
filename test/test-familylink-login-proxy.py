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

if failures:
    print("FAIL:", "; ".join(failures))
    sys.exit(1)
print("OK: familylink_login_proxy Logik (%d Pruefungen)" % checks[0])
