/**
 * Modul: Family-Link-Report-Push (POST /api/v1/media-time/familylink/report).
 * Zweck: nimmt den Report des Collector-Hosts an - des einzigen Rechners mit
 *        Google-Sitzung. Credential ist der Hash des x-familylink-token
 *        (gleiches Muster wie die Geraet-Tokens); eine Sitzung hat der Host
 *        nicht. Ungleicher/fehlender Token => 401, kaputter Koerper => 400 -
 *        geschrieben wird nie etwas Halbes, nie eine Null (Spec-Regel).
 * Mount: VOR dem globalen requireAuth in server/index.js (Muster wie das
 *        Tablett-Pairing /api/v1/displays).
 * Eigene Datei: der OpenAPI-Routen-Tracer (test/openapi-routes.js) ordnet
 *        alle Router-Eintragspfade eine Datei einem Mount zu - zwei Router
 *        in einer Datei wuerden die Pfade vermischen.
 * Abhaengigkeiten: server/services/familylink.js, server/services/media-time.js.
 */
import express from 'express';
import * as db from '../db.js';
import { ingestFamilylinkReport, setStatus } from '../services/familylink.js';
import { hashDeviceToken } from '../services/media-time.js';

export const familylinkReportRouter = express.Router();

// Eigener Mount mit Prefix '/api/v1' in server/index.js - der Pfad hier ist
// der Rest danach (Express haengt ihn an den Mount an).
familylinkReportRouter.post('/media-time/familylink/report', (req, res) => {
  try {
    const d = db.get();
    const stored = d.prepare(
      "SELECT value FROM sync_config WHERE key = 'familylink_report_token_hash'"
    ).get()?.value;
    const given = req.get('x-familylink-token') || '';
    if (!stored || !given || hashDeviceToken(given) !== stored) {
      return res.status(401).json({ error: 'Valid x-familylink-token required.', code: 401, reason: 'media_time_unauthenticated' });
    }
    const r = ingestFamilylinkReport(d, req.body);
    // Ein angenommener Push ist ein erfolgreicher Lauf - derselbe Status,
    // den der lokale Takt setzt (UI zeigt "Letzter Abruf: okay").
    setStatus(d, 'ok');
    return res.json({ data: { written: r.written, errors: r.errors } });
  } catch (err) {
    return res.status(400).json({ error: 'Report not accepted.', code: 400, reason: 'media_time_bad_request' });
  }
});
