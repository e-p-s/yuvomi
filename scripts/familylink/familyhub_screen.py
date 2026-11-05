#!/usr/bin/env python3
"""
familyhub_screen.py — Medienzeit-Report (Google Family Link).

Quelle: appliedTimeLimits-Template (via Family-Link-Web-App abgehört).
Pro Gerät: [consumed, ?, allowed, deviceId] Tupel + daily-limit Zeilen
[CAEQxx, weekday, state, minutes].

Usage:
  python3 familyhub_screen.py            # Textreport heute
  python3 familyhub_screen.py --json     # JSON
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.request

import importlib.util
CAP_DIR = os.environ.get("FAMILYHUB_SCRIPT_DIR", str(__import__("pathlib").Path(__file__).resolve().parent))
_spec = importlib.util.spec_from_file_location(
    "cap", os.path.join(CAP_DIR, "familyhub_capture2.py"))
cap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cap)

CACHE = os.path.expanduser("~/.familyhub")
TPL = os.path.join(CACHE, "tpl_appliedTimeLimits.json")
TPL_MEMBERS = os.path.join(CACHE, "tpl_members.json")
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")

WEEKDAYS = {1: "Mo", 2: "Di", 3: "Mi", 4: "Do", 5: "Fr", 6: "Sa", 7: "So"}


def get_browser():
    cap.ensure_chromium()
    t = cap.page_target()
    return cap.WS(t["webSocketDebuggerUrl"])


def repl(url, headers, sid):
    if sid:
        ts = int(time.time())
        h = hashlib.sha1(f"{ts} {sid} https://familylink.google.com".encode()).hexdigest()
        url = re.sub(r"SAPISIDHASH\+[0-9]+_[0-9a-f]{40}", f"SAPISIDHASH+{ts}_{h}", url, count=1)
    req = urllib.request.Request(url, headers={
        "Cookie": headers.get("Cookie", ""),
        "Origin": "https://familylink.google.com",
        "Referer": "https://familylink.google.com/",
        "User-Agent": headers.get("User-Agent", UA)})
    return json.loads(urllib.request.urlopen(req, timeout=25).read().decode())


def learn_uid_template(ws, uid, timeout=90):
    ws.call("Fetch.enable", {"patterns": [
        {"urlPattern": "*kidsmanagement*appliedTimeLimits*", "requestStage": "Request"}]})
    ws.call("Page.enable")
    ws.call("Page.navigate", {"url": "https://familylink.google.com/"})
    t0 = time.time()
    ws.s.settimeout(timeout)
    tpl = None
    while time.time() - t0 < timeout:
        try:
            m = ws._recv()
        except Exception:
            break
        if m.get("method") == "Fetch.requestPaused":
            p = m["params"]
            req = p["request"]
            ws.call("Fetch.continueRequest", {"requestId": p["requestId"]})
            if f"/people/{uid}/appliedTimeLimits" in req["url"] and req.get("headers", {}).get("Cookie"):
                tpl = {"url": req["url"], "headers": req["headers"], "uid": uid,
                       "saved": time.strftime("%F %T")}
                break
    ws.call("Fetch.disable")
    return tpl


def parse_applied(data):
    """data[1] = ein Element pro Gerät:
    [12] = [?, ?, verbleibende_Minuten_bis_Downtime, deviceId] — zählt live
            herunter (verifiziert 2026-11-05: 376→375 bei 20s). Solange der
            Tageslimit noch nicht erreicht ist, ist dieser Wert = Zeit bis
            Downtime (keinconsumed!).
    [26] = ['CAEQxx', weekday, state, daily_limit_minutes, createdMs, updatedMs]
    [9]/[10] = Downtime-Start/-Ende (epoch ms).
    consumed_min = Tageslimit − verbleibend, aber nur wenn verbleibend < Limit
    (d.h. das Tageslimit ist bereits angebrochen); sonst 0."""
    out = {"devices": [], "daily_limit_minutes": None, "downtime": None}
    if not (isinstance(data, list) and len(data) > 1 and isinstance(data[1], list)):
        return out
    wd_today = time.localtime().tm_wday % 7 + 1  # Mo=1 … So=7
    daily_min = None
    for node in data[1]:
        if not isinstance(node, list):
            continue
        dl = node[26] if len(node) > 26 and isinstance(node[26], list) else None
        if dl and len(dl) >= 4 and isinstance(dl[1], int) and isinstance(dl[3], int) \
                and dl[1] == wd_today and dl[2] == 2:
            daily_min = dl[3]
    out["daily_limit_minutes"] = daily_min
    for node in data[1]:
        if not isinstance(node, list):
            continue
        agg = node[12] if len(node) > 12 and isinstance(node[12], list) else None
        dt_start = node[9] if len(node) > 9 and isinstance(node[9], str) and node[9].isdigit() else None
        dt_end = node[10] if len(node) > 10 and isinstance(node[10], str) and node[10].isdigit() else None
        if agg and len(agg) >= 3:
            remaining = float(agg[2])
            if daily_min is not None and remaining < daily_min:
                consumed = round(daily_min - remaining, 1)
                allowed = float(daily_min)
            else:
                # Tageslimit noch nicht angebrochen: remaining = Zeit bis Downtime
                consumed = 0.0
                allowed = float(daily_min) if daily_min is not None else remaining
            out["devices"].append({
                "deviceId": str(agg[-1]),
                "consumed_min": consumed,
                "allowed_min": allowed,
                "remaining_min": round(remaining, 1)})
        if dt_start and dt_end and not out["downtime"]:
            import datetime
            s = datetime.datetime.fromtimestamp(int(dt_start) / 1000)
            e = datetime.datetime.fromtimestamp(int(dt_end) / 1000)
            out["downtime"] = f"{s:%H:%M}–{e:%H:%M}"
    return out


def kids(ws):
    """Mitglieder aus members-Template (oder live via Browser)."""
    sid = {c["name"]: c["value"] for c in cap.get_all_cookies(ws)
           if c["domain"] == ".google.com"}.get("SAPISID")
    if not os.path.exists(TPL_MEMBERS):
        return [], sid
    data = repl(json.load(open(TPL_MEMBERS))["url"],
                json.load(open(TPL_MEMBERS))["headers"], sid)
    out = []

    def walk(node):
        if isinstance(node, list):
            if (len(node) >= 4 and isinstance(node[0], str) and node[0].isdigit()
                    and isinstance(node[2], int) and isinstance(node[3], list)):
                prof = node[3]
                out.append({"userId": node[0],
                            "name": prof[0] if prof and isinstance(prof[0], str) else "?",
                            "supervised": node[2] == 4})
                return
            for c in node:
                walk(c)

    walk(data)
    return out, sid


def main():
    ws = get_browser()
    childlist, sid = kids(ws)
    today = time.strftime("%Y-%m-%d")
    report = {"date": today, "children": []}
    want_uid = os.environ.get("FAMILYHUB_UID")
    targets = [k for k in childlist if k["supervised"] and
               (not want_uid or k["userId"] == want_uid)]
    for k in targets:
        tpl = None
        # uid-spezifisches Template bevorzugen (tpl_appliedTimeLimits_<uid>.json),
        # sonst generisches Template; Pfad-Umbau auf Ziel-uid ist zulässig (verifiziert).
        per_uid = os.path.join(CACHE, f"tpl_appliedTimeLimits_{k['userId']}.json")
        for cand in ([per_uid] if os.path.exists(per_uid) else []) + \
                    ([TPL] if os.path.exists(TPL) else []):
            j = json.load(open(cand))
            fresh = (time.time() - os.path.getmtime(cand)) < 6 * 3600
            if not fresh:
                continue
            if j.get("uid") == k["userId"]:
                tpl = j
            else:
                tpl = dict(j)
                tpl["url"] = re.sub(r"/people/\d+/", f"/people/{k['userId']}/", j["url"])
                tpl["uid"] = k["userId"]
            break
        if tpl is None:
            tpl = learn_uid_template(ws, k["userId"])
            if tpl:
                json.dump(tpl, open(per_uid, "w"), indent=1)
                os.chmod(per_uid, 0o600)
        if tpl is None:
            report["children"].append({"name": k["name"], "error": "template nicht abhörbar"})
            continue
        data = repl(tpl["url"], tpl["headers"], sid)
        parsed = parse_applied(data)
        report["children"].append({
            "name": k["name"], "userId": k["userId"],
            "devices": [{
                         # volles Feld `id` für den FamilyHub-Ingest (M15);
                         # `id_short` bleibt für den Textreport/Abwärtskompatibilität.
                         "id": d["deviceId"],
                         "id_short": d["deviceId"][:8],
                         "consumed_min": d["consumed_min"],
                         "allowed_min": d["allowed_min"],
                         "remaining_min": round(d["allowed_min"] - d["consumed_min"], 1)}
                        for d in parsed["devices"]],
            "daily_limit_minutes": parsed["daily_limit_minutes"],
            "downtime": parsed["downtime"],
        })
    if "--json" in sys.argv:
        print(json.dumps(report, indent=1, ensure_ascii=False))
    else:
        print(f"Medienzeit — {today}")
        for c in report["children"]:
            print(f"\n{c['name']}:")
            if "error" in c:
                print("  !", c["error"])
                continue
            if c.get("daily_limit_minutes"):
                print(f"  Limit heute: {c['daily_limit_minutes']} min | Downtime {c.get('downtime')}")
            for d in c["devices"]:
                print(f"  Gerät {d['id_short']}: {d['consumed_min']} min verbraucht"
                      f" / {d['allowed_min']} min erlaubt"
                      f" → {d['remaining_min']} min übrig")


if __name__ == "__main__":
    main()
