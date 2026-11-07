#!/usr/bin/env bash
# deploy-prod.sh — bringt den Fork-Zweig prod auf CT135 (Yuvomi, ProxNas).
# Schritt-fuer-Schritt mit Backup, Backup-Verifikation, Health-Check und Rollback-Hinweis.
# Aufruf: bash /mnt/tank/coding/privat/yuvomi-fork/deploy/deploy-prod.sh [--dry-run]
set -euo pipefail

PROXNAS=172.30.20.200
SSH_USER=root
CT=135
APP_DIR=/opt/yuvomi
LOCAL_DIR=/mnt/tank/coding/privat/yuvomi-fork
STAGE=/tmp/yuvomi-prod-deploy
HEALTH_URL=http://172.30.95.198:3000/api/v1/health
VERSION_URL=http://172.30.95.198:3000/version
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

run_remote() {
  # sshpass sitzt auf dem Worker; Passwort aus der Cred-Karte (Wiki cred-030)
  sshpass -p "$PROXNAS_PW" ssh -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$SSH_USER@$PROXNAS" "$@"
}
run_ct() { run_remote "pct exec $CT -- bash -c '$1'"; }

: "${PROXNAS_PW:?PROXNAS_PW muss gesetzt sein (Wiki: meta/credentials-cards/cred-030-proxnas-ssh.md)}"

echo "== 1/7 Staging: prod-Zweig sauber auspacken =="
git -C "$LOCAL_DIR" rev-parse --verify prod >/dev/null
[[ -z "$(git -C "$LOCAL_DIR" status --porcelain)" ]] || { echo "FAIL: Arbeitsverzeichnis ist nicht sauber."; exit 1; }
rm -rf "$STAGE"
git -C "$LOCAL_DIR" worktree prune
git -C "$LOCAL_DIR" worktree add --detach "$STAGE" prod >/dev/null
FORK_SHA=$(git -C "$STAGE" rev-parse --short HEAD)
echo "prod = $FORK_SHA"

echo "== 2/7 Backup auf CT135 (DB + Baum) =="
STAMP=$(date +%Y%m%dT%H%M)
run_ct "cp $APP_DIR/data/yuvomi.db $APP_DIR/backups/pre-deploy-$STAMP.db && test -s $APP_DIR/backups/pre-deploy-$STAMP.db && echo DB_BACKUP_OK"
run_ct "tar -C $APP_DIR --exclude=node_modules --exclude=data --exclude=backups -czf /root/pre-deploy-$STAMP.tar.gz . && test -s /root/pre-deploy-$STAMP.tar.gz && mv /root/pre-deploy-$STAMP.tar.gz $APP_DIR/backups/ && echo TREE_BACKUP_OK"
[[ $DRY -eq 1 ]] && { echo "DRY-RUN: hier wurde abgebrochen, nichts veraendert."; exit 0; }

echo "== 3/7 Upload (Baum ohne node_modules/data/.env) =="
tar -C "$STAGE" --exclude=node_modules --exclude=data --exclude=.env -czf - . | run_remote "pct exec $CT -- tar -C $APP_DIR -xzf -"

echo "== 4/7 npm ci auf CT135 =="
run_ct "cd $APP_DIR && npm ci --omit=dev >/tmp/npmci.log 2>&1 && echo NPM_OK || (tail -5 /tmp/npmci.log; exit 1)"

echo "== 5/7 Remap der schema_migrations (Pflicht nach dem Merge auf v2.86.0) =="
# Der Laeufer entscheidet nach der Versionsnummer: unsere 279-288 heissen jetzt
# 283-292. Ohne Umschreibung blieben die offiziellen 278-281 aus, und der Laeufer
# wollte unsere 289-292 auf eine Datenbank loslassen, in der sie laengst laufen
# (Probelauf: "duplicate column name: kind"). Das Skript ist ein No-op, wenn die
# DB den Zielzustand schon hat oder nie unter den alten Nummern lief - und der
# Dienst muss dafuer stehen, weil die Umschreibung schreiben will.
run_ct "systemctl stop yuvomi.service && sleep 2 && systemctl is-active yuvomi.service || true"
run_ct "cd $APP_DIR && set -a && . ./.env && set +a && node deploy/remap-2.86.0.mjs --write 2>&1 | tail -4"

echo "== 6/7 Restart + Migrationen =="
# APP_BUILD_REVISION in .env auf den Deploy-Sha: damit aendert sich der
# Service-Worker-Cache-Name (sw.js rendert ihn aus der Umgebungsvariable) und
# die Clients holen sich beim naechsten Oeffnen das neue Buendel statt dem
# Cache-First-Stand des alten Service Workers.
run_ct "cp $APP_DIR/.env $APP_DIR/backups/pre-deploy-$STAMP.env && grep -v ^APP_BUILD_REVISION= $APP_DIR/backups/pre-deploy-$STAMP.env > $APP_DIR/.env.tmp && mv $APP_DIR/.env.tmp $APP_DIR/.env; echo APP_BUILD_REVISION=$FORK_SHA >> $APP_DIR/.env"
run_ct "systemctl restart yuvomi.service && sleep 3 && systemctl is-active yuvomi.service"

echo "== 7/7 Health-Check (max 60s) =="
# /api/v1/health ist auth-pflichtig; 401/403 zeigen einen lebenden Server an.
OK=0
for i in $(seq 1 12); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" || true)
  if [[ "$CODE" == "200" || "$CODE" == "401" || "$CODE" == "403" ]]; then OK=1; break; fi
  sleep 5
done
if [[ $OK -eq 1 ]]; then
  echo "HEALTH_OK (HTTP $CODE)"
  curl -fsS --max-time 5 "$VERSION_URL" | head -c 200; echo
  echo "Deployment fertig. Rollback bei Bedarf:"
  echo "  cp $APP_DIR/backups/pre-deploy-$STAMP.db $APP_DIR/data/yuvomi.db && systemctl restart yuvomi"
else
  echo "FEHLER: Health-Check fehlgeschlagen. Rollback:"
  echo "  run_ct: cp $APP_DIR/backups/pre-deploy-$STAMP.db $APP_DIR/data/yuvomi.db"
  echo "  und Baum aus pre-deploy-$STAMP.tar.gz zurueckspielen, dann systemctl restart yuvomi"
  exit 1
fi
