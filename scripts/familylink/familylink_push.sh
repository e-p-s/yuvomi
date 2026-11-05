#!/usr/bin/env bash
# familylink_push.sh - schickt den Family-Link-Report vom Collector-Host zur
# Yuvomi-Instanz (POST /api/v1/media-time/familylink/report). Der Report ist
# tageweise; mehrfache Laeufe am Tag ueberschreiben die Zeilen (Idempotenz).
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

TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
if [[ -z "$TOKEN" ]]; then
  echo "familylink_push: leerer Token in $TOKEN_FILE" >&2
  exit 1
fi

python3 "$DIR/familyhub_screen.py" --json \
  | curl -fsS --max-time 60 -X POST "$URL/api/v1/media-time/familylink/report" \
      -H 'content-type: application/json' \
      -H "x-familylink-token: $TOKEN" \
      --data-binary @-
