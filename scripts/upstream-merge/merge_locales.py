#!/usr/bin/env python3
"""Upstream-Locale-Deep-Merge: schaetzt beide Seiten und schuetzt unsere Regeln.

Anlass (06.11.2026, Merge v2.87.0): ein naiver git-Merge der 27 Locale-Dateien
erzeugt bei jedem Release Konflikte, und ein globaler Dash-Fix zerstoert die
legitime chinesische Doppelform '——'. Dieses Skript loest das deterministisch:

  python3 scripts/upstream-merge/merge_locales.py <BASE_REV> <UPSTREAM_REV>

  1. Liest pro Locale die drei Staeende als JSON (git-Blobs, kein Merge-State
     noetig): BASE = merge-base, OURS = aktueller Branch, THEIRS = Upstream.
  2. Ergebnis: Upstream-Struktur und -Reihenfolge, Upstream-Werte gewinnen bei
     Key-Konflikten (beide haben geaendert), unsere neuen Keys (nie im BASE)
     und unsere Allein-Aenderungen bleiben stehen.
  3. Dash-Normalisierung (unser Hausgesetz: kein Einzel-En/Em-Dash) ueber die
     ganze Datei - die Doppelform '——' (zh/zh-Hant, test-i18n-Ausnahme) bleibt
     unangetastet, ebenso die ru/uk-Ausnahme tasks.subtaskDeleteDetail.

Nach dem Lauf: `npm run test:i18n && npm run test:i18n-translated` muss gruen
sein; git zeigt dann nur echte Inhaltsaenderungen, keinen Konfliktmuell.
"""
import json
import re
import subprocess
import sys

SENT = '\ue000\ue000'  # Private-Use-Sentinel fuer die geschuetzte Doppelform
DASH_KEY_EXCEPTIONS = {  # locale -> Keys, die ihren Gedankenstrich behalten
    'ru': {'tasks.subtaskDeleteDetail'},
    'uk': {'tasks.subtaskDeleteDetail'},
}


def dashfix(txt: str) -> str:
    txt = txt.replace('——', SENT)
    txt = re.sub(r'\s*[\u2013\u2014]\s*', ' - ', txt)
    return txt.replace(SENT, '——')


def blob(rev: str, f: str):
    r = subprocess.run(f'git show {rev}:{f}', shell=True,
                       capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else {}


def flat(d, pre=''):
    out = {}
    for k, v in d.items():
        p = f'{pre}.{k}' if pre else k
        if isinstance(v, dict):
            out.update(flat(v, p))
        else:
            out[p] = v
    return out


def set_deep(d, path, val):
    cur = d
    parts = path.split('.')
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = val


def main():
    base, upstream = sys.argv[1], sys.argv[2]
    files = subprocess.run("git ls-files 'public/locales/*.json'", shell=True,
                           capture_output=True, text=True).stdout.split()
    for f in sorted(files):
        locale = f.split('/')[-1][:-len('.json')]
        b, ours, theirs = (flat(blob(rev, f))
                          for rev in (base, 'HEAD', upstream))
        result = dict(theirs)
        for k, v in ours.items():
            if k not in b:
                result[k] = v  # unsere Erweiterung
            elif (k not in theirs or theirs[k] == b.get(k)) and ours[k] != b.get(k):
                result[k] = ours[k]  # unsere Allein-Aenderung
        # Ausnahme-Keys: unser Stand (Strich traegt ihn per Definition)
        for k in DASH_KEY_EXCEPTIONS.get(locale, ()):
            if k in ours:
                result[k] = ours[k]
        vals = dict(result)

        def build(prefix, src):
            out = {}
            for k in src:
                p = f'{prefix}.{k}' if prefix else k
                if isinstance(src[k], dict):
                    sub = build(p, src[k])
                    if sub:
                        out[k] = sub
                elif p in vals:
                    out[k] = vals.pop(p)
            return out

        ordered = build('', blob(upstream, f))
        for p, v in vals.items():
            set_deep(ordered, p, v)
        txt = json.dumps(ordered, ensure_ascii=False, indent=4) + '\n'
        # Schutzzone: Ausnahme-Keys duerfen ihren Strich nicht verlieren
        with open(f, 'w', encoding='utf-8') as fh:
            fh.write(dashfix(txt))
    print(f'{len(files)} Locales gemischt (base={base}, upstream={upstream})')


if __name__ == '__main__':
    main()
