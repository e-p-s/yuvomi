#!/usr/bin/env python3
"""
familyhub_media.py — Medienzeit-Report (Google Family Link, kidsmanagement/v1).

Funktionsprinzip (live verifiziert 2026-11-05):
  1. Laufendes Chromium (CDP :9333, Profil ~/.config/chromium-familyhub) muss
     auf familylink.google.com eingeloggt sein.
  2. Ein echter App-Request wird via Fetch.requestPaused abgehört. Pro
     Endpunkt (members / appsandusage / appliedTimeLimits) wird das Original
     1:1 als Replay-Template gespeichert (~/.familyhub/tpl_<name>.json).
  3. Replikierte Requests senden URL + Header unverändert — nur der
     SAPISIDHASH-Wert (Muster 'SAPISIDHASH+<ts>_<sha1>' im Query) wird mit
     frischem Zeitstempel/SHA1 ersetzt. Umbau von Pfad/Query führte zu 404 —
     Google routet streng über die exakte abgehörte URL.

Usage:
  python3 familyhub_media.py            # Report heute
  python3 familyhub_media.py --json     # + Rohdateien ~/.familyhub/child_<uid>.json
  python3 familyhub_media.py --learn    # alle Templates neu abhören (nach Login-Wechsel)
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

import importlib.util
CAP_DIR = os.environ.get("FAMILYHUB_SCRIPT_DIR", str(__import__("pathlib").Path(__file__).resolve().parent))
_spec = importlib.util.spec_from_file_location(
    "cap", os.path.join(CAP_DIR, "familyhub_capture2.py"))
cap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cap)

CACHE = os.path.expanduser("~/.familyhub")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")
TPL_TTL_H = 6

# Endpunkt-Muster -> Template-Name
ENDPOINTS = {
    "members": "mine/members?",
    "appsandusage": "appsandusage",
    "appliedTimeLimits": "appliedTimeLimits",
}


def get_browser():
    cap.ensure_chromium()
    t = cap.page_target()
    return t, cap.WS(t["webSocketDebuggerUrl"])


def _session():
    """session.json (der Login-Export) — einzige Quelle ohne offenen Browser."""
    try:
        with open(os.path.join(CACHE, "session.json")) as f:
            return json.load(f)
    except Exception:
        return {}


def session_cookie():
    cookies = [c for c in _session().get("cookies") or []
               if isinstance(c, dict) and str(c.get("domain", "")).endswith("google.com")
               and c.get("name") and c.get("value") is not None]
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


def session_sid():
    for c in _session().get("cookies") or []:
        if isinstance(c, dict) and c.get("name") == "SAPISID":
            return c.get("value")
    return None


def tpl_path(name):
    return os.path.join(CACHE, f"tpl_{name}.json")


def learn_templates(ws, names, timeout=90):
    """App-Reload abwarten und pro Endpunkt das Original-Template sichern."""
    want = set(names)
    found = {}
    ws.call("Fetch.enable", {"patterns": [
        {"urlPattern": "*kidsmanagement*v1/*", "requestStage": "Request"}]})
    ws.call("Page.enable")
    ws.call("Page.navigate", {"url": "https://familylink.google.com/"})
    t0 = time.time()
    ws.s.settimeout(timeout)
    while time.time() - t0 < timeout and want - set(found):
        try:
            m = ws._recv()
        except Exception:
            break
        if m.get("method") == "Fetch.requestPaused":
            p = m["params"]
            req = p["request"]
            ws.call("Fetch.continueRequest", {"requestId": p["requestId"]})
            u = req["url"]
            if "kidsmanagement" in u and req.get("headers", {}).get("Cookie"):
                for name, pat in ENDPOINTS.items():
                    if name in want and name not in found and pat in u:
                        found[name] = {"url": u, "headers": req["headers"],
                                       "saved": time.strftime("%Y-%m-%dT%H:%M:%S")}
                        os.makedirs(CACHE, exist_ok=True)
                        json.dump(found[name], open(tpl_path(name), "w"), indent=1)
                        os.chmod(tpl_path(name), 0o600)
    ws.call("Fetch.disable")
    return found


def ensure_templates(ws, force=False):
    have = {}
    if not force:
        for name in ENDPOINTS:
            p = tpl_path(name)
            if os.path.exists(p):
                have[name] = json.load(open(p))
    missing = [n for n in ENDPOINTS if n not in have]
    if missing and ws is not None:
        have.update(learn_templates(ws, missing))
    return have


def refresh_session_cookies(headers):
    """Google rotiert bei jeder Antwort die Sitzungs-Cookies (z. B.
    __Secure-1PSIDTS): zurueckgeschrieben bleibt session.json gueltig — und
    ein request OHNE Zurueckschreiben wuerde die alte session abschiessen
    (07.11.-Befund: Probe-Laeufe ohne Refresh toteten die gueltige Sitzung)."""
    try:
        fresh = {}
        for line in headers.get_all("Set-Cookie") or []:
            name, _, value = line.partition(";")[0].partition("=")
            name = name.strip()
            if name:
                fresh[name] = value.strip()
        if not fresh:
            return
        p = os.path.join(CACHE, "session.json")
        if not os.path.exists(p):
            return
        with open(p) as f:
            data = json.load(f)
        cookies = data.get("cookies")
        if not isinstance(cookies, list):
            return
        changed = False
        for c in cookies:
            if isinstance(c, dict) and c.get("name") in fresh:
                c["value"] = fresh[c["name"]]
                changed = True
        if not changed:
            return
        data["exported"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        tmp = p + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    except Exception:
        pass


def repl(tpl, sapisid=None):
    """Template-URL mit frischem SAPISIDHASH; Header 1:1."""
    url = tpl["url"]
    if sapisid:
        ts = int(time.time())
        h = hashlib.sha1(f"{ts} {sapisid} https://familylink.google.com".encode()).hexdigest()
        # Nur die rohe Form ersetzen: in %2B-kodierten Kapseln (steckt gern im
        # $httpHeaders-Blob) waere ein rohes '+' eine neue URL — und Google
        # routet nur ueber die exakt abgehoerte (401/404-Befund 07.11.).
        url = re.sub(r"SAPISIDHASH\+[0-9]+_[0-9a-f]{40}",
                     f"SAPISIDHASH+{ts}_{h}", url, count=1)
    hdrs = tpl["headers"]
    req = urllib.request.Request(url, headers={
        # session.json ist die frische Quelle (der Login-Export, vom Cron
        # keep-alive gepflegt); der Template-Kopf ist nur der Notbehelf —
        # derselbe Fehler wie in familyhub_screen.py (07.11.): alter Cookie-
        # Kopf = 401 trotz gueltiger Sitzung.
        "Cookie": session_cookie() or hdrs.get("Cookie", ""),
        "Origin": hdrs.get("Origin", "https://familylink.google.com"),
        "Referer": hdrs.get("Referer", "https://familylink.google.com/"),
        "Accept-Language": hdrs.get("Accept-Language", "en-US"),
        "sec-ch-ua": hdrs.get("sec-ch-ua", '"Chromium";v="153", "Not_A Brand";v="8"'),
        "sec-ch-ua-mobile": hdrs.get("sec-ch-ua-mobile", "?0"),
        "sec-ch-ua-platform": hdrs.get("sec-ch-ua-platform", '"Linux"'),
        "User-Agent": hdrs.get("User-Agent", UA),
    })
    try:
        resp = urllib.request.urlopen(req, timeout=25)
        refresh_session_cookies(resp.headers)
        return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "body": e.read().decode("utf-8", "replace")[:200]}


def members(tpls, sid):
    data = repl(tpls["members"], sid)
    kids = []

    def walk(node):
        if isinstance(node, list):
            # Mitglied: [uid(str), null, flag(int), profile(list), ...]
            if (len(node) >= 4 and isinstance(node[0], str)
                    and node[0].isdigit() and isinstance(node[2], int)
                    and isinstance(node[3], list)):
                prof = node[3]
                kids.append({"userId": node[0],
                             "name": prof[0] if prof and isinstance(prof[0], str) else "?",
                             "supervised": node[2] == 4})
                return
            for c in node:
                walk(c)

    walk(data)
    return kids


def learn_child_templates(ws, uid, sid, member_idx=None):
    """appsandusage + appliedTimeLimits des Kindes abhoren: Seite ansteuern.

    Die Mitglieder-Seite hat eine kleine Index-Adresse (member/1, member/2 ...),
    nicht die Konten-UID - der Filter unten laeuft trotzdem ueber die UID, weil
    die batchexecute-Requests people/<uid> tragen. Ohne index werden alle
    Mitglieder-Durchgaenge probiert, bis einer die UID liefert."""
    want = ["appsandusage", "appliedTimeLimits"]
    have = {}
    ws.call("Fetch.enable", {"patterns": [
        {"urlPattern": "*kidsmanagement*v1/*", "requestStage": "Request"}]})
    ws.call("Page.enable")
    # Index-Adressen probieren (1..4): nur der richtige liefert die Requests
    # dieser UID; der Filter unten entscheidet, nicht geraten.
    cands = [member_idx] if member_idx else [1, 2, 3, 4]
    try:
        for idx in cands:
            if not want:
                break
            ws.call("Page.navigate", {"url": f"https://familylink.google.com/member/{idx}/screenTime"})
            t0 = time.time()
            ws.s.settimeout(45)
            while time.time() - t0 < 45 and want:
                try:
                    m = ws._recv()
                except Exception:
                    break
                if m.get("method") == "Fetch.requestPaused":
                    p = m["params"]
                    req = p["request"]
                    ws.call("Fetch.continueRequest", {"requestId": p["requestId"]})
                    u = req["url"]
                    if f"/people/{uid}/" in u and req.get("headers", {}).get("Cookie"):
                        for name in list(want):
                            if ENDPOINTS[name] in u:
                                want.remove(name)
                                have[name] = {"url": u, "headers": req["headers"],
                                              "saved": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                              "uid": uid}
                                json.dump(have[name], open(tpl_path(name), "w"), indent=1)
                                os.chmod(tpl_path(name), 0o600)
    finally:
        ws.call("Fetch.disable")
    return have


def parse_usage(data):
    """appsandusage → {pkg: {name, minutes}}. Sessions: positionale Arrays mit
    usage-String '<sek>s' und Paketname (aus data[0]-Deckblatt)."""
    apps = {}
    if not isinstance(data, list) or not data:
        return apps
    names = {}
    if isinstance(data[0], list):
        for a in data[0]:
            if isinstance(a, list) and len(a) > 1 and isinstance(a[0], str):
                names[a[0]] = a[1] if isinstance(a[1], str) else a[0]

    def find_pkg(node):
        if isinstance(node, list):
            if node and isinstance(node[0], str) and node[0] in names:
                return node[0]
            for c in node:
                r = find_pkg(c)
                if r:
                    return r
        return None

    def walk(node):
        if isinstance(node, list):
            strs = [x for x in node if isinstance(x, str) and re.fullmatch(r"[\d.]+s", str(x))]
            if strs:
                pkg = find_pkg(node)
                if pkg:
                    apps[pkg] = apps.get(pkg, 0) + sum(float(s[:-1]) for s in strs)
            for c in node:
                walk(c)

    for i in range(1, len(data)):
        walk(data[i])
    return {pkg: {"name": names.get(pkg, pkg), "minutes": round(s / 60, 1)}
            for pkg, s in apps.items()}


def report(as_json=False, force_learn=False):
    # Browser ist Chance, nicht Voraussetzung: ohne ihn arbeiten session.json
    # (sid + Cookies) und die vorhandenen Vorlagen weiter (Cron-tauglich).
    # FAMILYHUB_NO_BROWSER=1 (Push-Pfad) verhindert zusaetzlich, dass ein
    # Collector-Lauf nur fuer Apps einen ganzen Browser hochzieht.
    ws = None
    sid = None
    if not os.environ.get("FAMILYHUB_NO_BROWSER"):
        try:
            t, ws = get_browser()
            sidjar = {c["name"]: c["value"] for c in cap.get_all_cookies(ws)
                      if c["domain"] == ".google.com"}
            sid = sidjar.get("SAPISID")
        except Exception:
            ws = None
    if not sid:
        sid = session_sid()
    if not sid:
        raise SystemExit("SAPISID fehlt — weder Browser noch session.json kennt eins")
    tpls = ensure_templates(ws if force_learn else None, force=force_learn)
    if "members" not in tpls:
        raise SystemExit("members-Template fehlt — --learn ausführen")
    today = time.strftime("%Y-%m-%d")
    out = {"date": today, "children": []}
    for mb in members(tpls, sid):
        if not mb["supervised"]:
            continue
        uid = mb["userId"]
        # Per-uid-Vorlagen (vom Login-Fang oder frueherem Lernen) gelten
        # unbegrenzt; nur was fehlt, wird im Browser nachgehoert.
        ctpl = {}
        for name in ("appsandusage", "appliedTimeLimits"):
            for cand in (f"{name}_{uid}", name):
                p = tpl_path(cand)
                if os.path.exists(p):
                    ctpl[name] = json.load(open(p))
                    break
        if len(ctpl) < 2 and ws is not None:
            ctpl.update(learn_child_templates(ws, uid, sid))
        usage = repl(ctpl["appsandusage"], sid) if "appsandusage" in ctpl else {"_missing_tpl": True}
        applied = repl(ctpl["appliedTimeLimits"], sid) if "appliedTimeLimits" in ctpl else {"_missing_tpl": True}
        apps = parse_usage(usage) if isinstance(usage, list) else {}
        entry = {"name": mb["name"], "userId": uid,
                 "total_minutes_today": round(sum(a["minutes"] for a in apps.values()), 1),
                 "apps": sorted(apps.items(), key=lambda kv: -kv[1]["minutes"])[:15],
                 "applied_raw_preview": str(applied)[:300]}
        out["children"].append(entry)
        if as_json:
            os.makedirs(CACHE, exist_ok=True)
            json.dump({"entry": entry, "usage_raw": usage, "applied_raw": applied},
                      open(f"{CACHE}/child_{uid}.json", "w"), indent=1)
    return out


if __name__ == "__main__":
    r = report("--json" in sys.argv, "--learn" in sys.argv)
    # --json liefert volles JSON (Maschinen lesen mit); die 6000-Zeichen-
    # Kuerzung war nur fuer den Menschen am Terminal.
    print(json.dumps(r, indent=1, ensure_ascii=False)
          if "--json" in sys.argv else json.dumps(r, ensure_ascii=False)[:6000])
