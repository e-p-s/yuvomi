#!/usr/bin/env python3
"""Mergt die App-Nutzung (familyhub_media) in den Screen-Report zum Push.

familylink_push.sh ruft das nach familyhub_screen.py --json auf: pro Kind
mit ubereinstimmender userId bekommt der Report ein Feld apps — Liste von
[pkg, {name, minutes}]-Paaren, exakt die Form, die der Server-Ingest
(normalizeAppEntries) erwartet. Apps sind Zusatz: ohne sie bleibt der
Report unveraendert und der Push laeuft wie bisher durch.

Der Media-Teil laeuft ohne Browser (FAMILYHUB_NO_BROWSER): session.json
liefert sid + Cookies, repl schreibt rotierte Cookies zurueck — jeder
Push haltet damit die Google-Sitzung frisch.
"""
import importlib.util
import json
import os
import sys


def main():
    report_path = sys.argv[1]
    d = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "famhub_media", os.path.join(d, "familyhub_media.py"))
    med = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(med)
    os.environ["FAMILYHUB_NO_BROWSER"] = "1"
    try:
        media = med.report()
    except (SystemExit, Exception):
        # kein sid / Template fehlt / Netzwerk — Apps bleiben weg, Push geht
        return
    apps = {c["userId"]: c["apps"]
            for c in (media or {}).get("children", [])
            if isinstance(c, dict) and c.get("userId") and c.get("apps")}
    if not apps:
        return
    try:
        with open(report_path) as f:
            report = json.load(f)
    except Exception:
        return
    n = 0
    for child in report.get("children", []):
        got = apps.get(child.get("userId"))
        if got:
            child["apps"] = got
            n += 1
    if n:
        tmp = report_path + ".merged"
        with open(tmp, "w") as f:
            json.dump(report, f, ensure_ascii=False)
        os.replace(tmp, report_path)
    print(f"apps-merge: {n} Kind(er)", file=sys.stderr)


main()
