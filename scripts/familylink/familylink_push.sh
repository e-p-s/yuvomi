#!/usr/bin/env bash
# familylink_push.sh - schickt den Family-Link-Report vom Collector-Host zur
# Yuvomi-Instanz (POST /api/v1/media-time/familylink/report). Der Report ist
# tageweise; mehrfache Laeufe am Tag ueberschreiben die Zeilen (Idempotenz).
# Scheitert der Python-Teil an der abgelaufenen Google-Sitzung (401-Signatur
# der Skripte), geht genau ein Status-Report { "status": "login_noetig" } an
# dieselbe URL - die UI zeigt den Hinweis statt zu schweigen. Andere Fehler
# bleiben beim bisherigen Verhalten (Exit ungleich 0, Logzeile).
#
# Einrichtung (einmalig, auf dem Collector-Host):
#   1. In Yuvomi (Regeln, Gruppe 5) das Ingest-Token erzeugen lassen - es ist
#      nur einmal sichtbar.
#   2. Token in eine Datei mit 0600 legen:  chmod 600 ~/.familyhub/push_token
#   3. Cron (alle 5 Minuten, flock gegen Ueberlappen):
#      */5 * * * * /usr/bin/flock -n /tmp/familylink-push.lock \
#        /pfad/zu/scripts/familylink/familylink_push.sh >> ~/.familyhub/push.log 2>&1
set -euo pipefail

URL="${YUVOMI_URL:-http://172.30.95.198:3000}"
TOKEN_FILE="${FAMILYLINK_TOKEN_FILE:-$HOME/.familyhub/push_token}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT_URL="$URL/api/v1/media-time/familylink/report"

TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
if [[ -z "$TOKEN" ]]; then
  echo "familylink_push: leerer Token in $TOKEN_FILE" >&2
  exit 1
fi

post_json() {  # $1 = Dateiname mit JSON-Koerper
  curl -fsS --max-time 60 -X POST "$REPORT_URL" \
    -H 'content-type: application/json' \
    -H "x-familylink-token: $TOKEN" \
    --data-binary @"$1"
}

OUT="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"' EXIT

if python3 "$DIR/familyhub_screen.py" --json > "$OUT" 2> "$ERR"; then
  # Apps (A2) anhaengen, wenn der Media-Teil ohne Browser liefert — stiller
  # Zusatz: ohne Apps geht der Report unveraendert raus.
  python3 "$DIR/familylink_apps_merge.py" "$OUT" 2>/dev/null || true
  post_json "$OUT"
else
  rc=$?
  # 401-/Anmelde-Signaturen aus dem Code der Skripte: familyhub_screen.py
  # (repl -> urlopen) wirft bei toter Session den urllib-Traceback mit
  # 'HTTP Error 401', familyhub_media.py meldet 'SAPISID fehlt — Login
  # verloren'. Kein Passwort/Cookie steht in diesen Meldungen; die Logs
  # bleiben frei von Sitzungsdaten.
  if grep -qE 'HTTP Error 401|SAPISID fehlt|Login verloren' "$ERR"; then
    printf '{"status":"login_noetig"}' > "$OUT"
    if post_json "$OUT"; then
      echo "familylink_push: Google-Sitzung abgelaufen - status login_noetig gemeldet (rc=$rc)"
      exit 0
    fi
    echo "familylink_push: Status-Report konnte nicht gesendet werden (rc=$rc)" >&2
    exit 1
  fi
  # anderer Fehler: bisheriges Verhalten (Exit ungleich 0, Logzeile)
  echo "familylink_push: Collector-Lauf fehlgeschlagen (rc=$rc):" >&2
  tail -n 5 "$ERR" >&2
  exit 1
fi
