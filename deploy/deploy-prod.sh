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

echo "== 1/6 Staging: prod-Zweig sauber auspacken =="
git -C "$LOCAL_DIR" rev-parse --verify prod >/dev/null
[[ -z "$(git -C "$LOCAL_DIR" status --porcelain)" ]] || { echo "FAIL: Arbeitsverzeichnis ist nicht sauber."; exit 1; }
rm -rf "$STAGE"
git -C "$LOCAL_DIR" worktree add --detach "$STAGE" prod >/dev/null
FORK_SHA=$(git -C "$STAGE" rev-parse --short HEAD)
echo "prod = $FORK_SHA"

echo "== 2/6 Backup auf CT135 (DB + Baum) =="
STAMP=$(date +%Y%m%dT%H%M)
run_ct "cp $APP_DIR/data/yuvomi.db $APP_DIR/backups/pre-deploy-$STAMP.db && test -s $APP_DIR/backups/pre-deploy-$STAMP.db && echo DB_BACKUP_OK"
run_ct "tar -C $APP_DIR --exclude=node_modules --exclude=data -czf $APP_DIR/backups/pre-deploy-$STAMP.tar.gz . && test -s $APP_DIR/backups/pre-deploy-$STAMP.tar.gz && echo TREE_BACKUP_OK"
[[ $DRY -eq 1 ]] && { echo "DRY-RUN: hier wurde abgebrochen, nichts veraendert."; exit 0; }

echo "== 3/6 Upload (Baum ohne node_modules/data/.env) =="
tar -C "$STAGE" --exclude=node_modules --exclude=data --exclude=.env -czf - . | run_remote "pct exec $CT -- tar -C $APP_DIR -xzf -"

echo "== 4/6 npm ci auf CT135 =="
run_ct "cd $APP_DIR && npm ci --omit=dev >/tmp/npmci.log 2>&1 && echo NPM_OK || (tail -5 /tmp/npmci.log; exit 1)"

echo "== 5/6 Restart + Migrationen =="
run_ct "systemctl restart yuvomi.service && sleep 3 && systemctl is-active yuvomi.service"

echo "== 6/6 Health-Check (max 60s) =="
OK=0
for i in $(seq 1 12); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done
if [[ $OK -eq 1 ]]; then
  echo "HEALTH_OK"
  curl -fsS --max-time 5 "$VERSION_URL" | head -c 200; echo
  echo "Deployment fertig. Rollback bei Bedarf:"
  echo "  cp $APP_DIR/backups/pre-deploy-$STAMP.db $APP_DIR/data/yuvomi.db && systemctl restart yuvomi"
else
  echo "FEHLER: Health-Check fehlgeschlagen. Rollback:"
  echo "  run_ct: cp $APP_DIR/backups/pre-deploy-$STAMP.db $APP_DIR/data/yuvomi.db"
  echo "  und Baum aus pre-deploy-$STAMP.tar.gz zurueckspielen, dann systemctl restart yuvomi"
  exit 1
fi
