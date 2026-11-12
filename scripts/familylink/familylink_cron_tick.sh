#!/usr/bin/env bash
# familylink_cron_tick.sh — entscheidet bei jedem Cron-Tick (alle 5 min), ob
# JETZT eine Google-Abfrage sinnvoll ist. Ziel: kein maschinell wirkendes
# Muster (feste 5-Minute-Kette war der Ausgangszustand 05.11.).
#
# Regeln (Konfiguration in ~/.familyhub/schedule.json, per App editierbar):
#   - nur im aktiven Fenster (Standard 06:00-21:00)
#   - nie in Blackout-Zeiten (Standard: Schulzeit Mo-Fr 08:00-13:30)
#   - nach jeder erfolgreichen Abfrage: neue Mindestpause, zufaellig
#     1500-5400 s (25-90 min), plus 0-240 s Vorlaufjitter
#   - max_abstand (Standard 3 h): nachts ist der Abstand hinf鋖lig, der
#     n鋍hste Tick im Fenster sammelt sofort (Daten bleiben frisch)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHED="${FAMILYHUB_SCHEDULE:-$HOME/.familyhub/schedule.json}"
STATE="${FAMILYHUB_STATE:-$HOME/.familyhub/collect_state}"

DEC=$(python3 - "$SCHED" "$STATE" <<'PY'
import json, os, sys, time, random, datetime
sched_p, state_p = sys.argv[1], sys.argv[2]
cfg = {"active_from": 6, "active_to": 21, "min_pause": 1500, "max_pause": 5400,
       "max_abstand": 10800,
       "blackout": [{"from": "08:00", "to": "13:30", "days": [1, 2, 3, 4, 5]}]}
try:
    cfg.update(json.load(open(sched_p)))
except Exception:
    pass
try:
    st = json.load(open(state_p))
except Exception:
    st = {}
now = time.time()
lt = time.localtime(now)
day = datetime.date.fromtimestamp(now)


def hm(v):
    if isinstance(v, (int, float)):
        return int(v) * 60
    h, m = str(v).split(":")
    return int(h) * 60 + int(m)


mins = lt.tm_hour * 60 + lt.tm_min
if not (hm(cfg["active_from"]) <= mins <= hm(cfg["active_to"])):
    sys.exit("outside")
wd = day.isoweekday()
for b in cfg.get("blackout", []):
    if wd in b.get("days", [1, 2, 3, 4, 5]) and hm(b["from"]) <= mins <= hm(b["to"]):
        sys.exit("blackout")
last = st.get("last", 0)
nxt = st.get("next", 0)
if now < nxt and (now - last) < float(cfg["max_abstand"]):
    sys.exit("wait")
print(int(random.uniform(float(cfg["min_pause"]), float(cfg["max_pause"]))))
PY
) || { echo "tick: $DEC"; exit 0; }

# Entscheidung: Abfrage — mit kleinem zeitlichem Versatz (Anti-Taktmuster).
sleep $((RANDOM % 240))
NOW=$(date +%s)
if bash "$DIR/familylink_push.sh"; then
  python3 - "$STATE" "$NOW" "$DEC" <<'PY'
import json, sys
json.dump({"last": int(sys.argv[2]), "next": int(sys.argv[2]) + int(sys.argv[3])},
          open(sys.argv[1], "w"))
PY
  echo "tick: gesammelt (naechster Fruehestlauf in ${DEC}s)"
fi
