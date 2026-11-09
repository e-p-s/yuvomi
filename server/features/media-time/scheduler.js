/**
 * Feature-Modul Medienzeit: der Family-Link-Ingest-Takt (Einbau-Spec HANDOVER.md).
 *
 * Der Takt holt alle fuenf Minuten den Collector-Report (nur auf dem
 * Collector-Host mit Google-Sitzung liefert er Zahlen; sonst setzt er den
 * Status 'login_noetig', nie 0er-Snapshots). Laeuft nur, wenn der Haushalt den
 * Schalter in den Regeln anwirft - der Takt selbst ist unref't wie die
 * uebrigen Scheduler. In server/index.js bleibt nur der Aufruf.
 */
export function startFamilylinkScheduler({ db, runExternalJob, log }) {
  const familylinkTick = () => {
    runExternalJob(async () => {
      const d = db.get();
      const on = d.prepare(
        "SELECT value FROM sync_config WHERE key = 'familylink_ingest_enabled'"
      ).get()?.value === '1';
      if (!on) return;
      const svc = await import('./familylink.js');
      const r = await svc.runFamilylinkIngest(d, {
        command: d.prepare(
          "SELECT value FROM sync_config WHERE key = 'familylink_ingest_command'"
        ).get()?.value,
      });
      if (!r.ok && r.status !== 'ok') log.info(`Family-Link-Ingest: ${r.status} (kein Snapshot geschrieben).`);
    }).catch((e) => log.error('Family-Link tick failed:', e.message));
  };
  setTimeout(() => {
    familylinkTick();
    setInterval(familylinkTick, 5 * 60_000).unref();
  }, 20_000).unref();
}
