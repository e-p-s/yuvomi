/**
 * Modul: Medienzeit (Bildschirmzeit-Kontingente) - REST-Schicht
 * Zweck: Prefix /api/v1/media-time. Der Tracker meldet Sessions (Gerate-Token),
 *        Eltern/Admin verwalten Kontingente, Ausnahmen und Quiet-Hours
 *        (Session-Cookie, media_manage-Berechtigung). docs/medienzeit-konzept.md.
 * Abhaengigkeiten: express, server/db.js, server/services/media-time.js
 *
 * ZWEI Identitaeten, zwei Wege:
 *   - Tracker-Pfade (/tracker/*) laufen mit einem Gerate-Token aus
 *     media_time_devices (Bearer). Das Gerat IST die Identitaet des Kindes;
 *     req.authUserId darf dem Gerat gehoren oder nicht - die Gerate-Zeile
 *     entscheidet, wessen Kontingent gilt (Ein Elternteil mit eigenem Login
 *     kann einem Kind nicht fremde Sessions unterschieben).
 *   - Verwaltungs-Pfade brauchen eine Session oder ein Token der Person und
 *     fragen isAdminRequest ODER family_role in (dad, mom, parent) - dasselbe
 *     Muster wie POST /rewards/penalty.
 */

import crypto from 'node:crypto';
import express from 'express';

import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import {
  YUVOMI_PACKAGE,
  MAX_SESSIONS_PER_SYNC,
  STALE_SESSION_CAP_MIN,
  RAW_RETENTION_DAYS,
  mediaTimeEnabled,
  mediaTimeQuietWindow,
  quietWindowActive,
  parseQuietHours,
  mediaTimeExchangeRate,
  parseExchangeRate,
  mediaTimeHardCap,
  hashDeviceToken,
  deviceByTokenHash,
  activeExceptionRules,
  classifySession,
  dayUsage,
  quotaRow,
  quotaState,
  reclassifyForUser,
  exceptionsVersion,
  trackerStatus,
  mediaTimeDayKey,
  householdWallTime,
} from '../services/media-time.js';

const log = createLogger('MediaTime');
const router = express.Router();

const MAX_PATTERN_LENGTH = 200;
const MAX_NOTE_LENGTH = 500;
const MAX_NAME_LENGTH = 100;

function actingUser(req) {
  return req.authUserId || req.session?.userId || null;
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toInt(val) {
  const n = Math.trunc(Number(val));
  return Number.isFinite(n) ? n : NaN;
}

/** Eltern (dad/mom/parent) oder Admin - dieselbe Frage wie bei Konsequenzen. */
function isParentOrAdmin(req) {
  if (isAdminRequest(req)) return true;
  const actor = actingUser(req);
  if (!actor) return false;
  const row = db.get().prepare('SELECT role, family_role FROM users WHERE id = ?').get(actor);
  return !!row && (row.role === 'admin' || ['dad', 'mom', 'parent'].includes(row.family_role));
}

function requireManager(req, res, next) {
  if (!isParentOrAdmin(req)) {
    return res.status(403).json({
      error: 'Only parents can manage media time.', code: 403, reason: 'media_time_forbidden',
    });
  }
  return next();
}

/** Kind-Zeile pruefen (Verwaltung pfadet nur gegen Kinder). */
function childRefusal(d, targetId) {
  const target = d.prepare('SELECT id, family_role, deactivated_at FROM users WHERE id = ?').get(targetId);
  if (!target || target.deactivated_at) return { status: 404, error: 'User not found.' };
  if (target.family_role !== 'child') {
    return { status: 403, error: 'Media time quotas apply to children only.', reason: 'media_time_not_a_child' };
  }
  return null;
}

/** Bearer-Token aus dem Header (Gerate-Pfade). */
function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Gerate-Token authentifizieren. Liefert { device } oder antwortet selbst
 * (401). Der Klartext wird NIE gespeichert - nur der Hash steht in der DB.
 */
function trackerDevice(req, res) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'A device token is required.', code: 401, reason: 'media_time_device_required' });
    return null;
  }
  const device = deviceByTokenHash(db.get(), hashDeviceToken(token));
  if (!device) {
    res.status(401).json({ error: 'Unknown or revoked device token.', code: 401, reason: 'media_time_device_required' });
    return null;
  }
  if (!mediaTimeEnabled(db.get())) {
    res.status(403).json({
      error: 'Media time is not enabled for this household.', code: 403, reason: 'media_time_disabled',
    });
    return null;
  }
  return device;
}

// --------------------------------------------------------
// POST /tracker/sync — Sessions annehmen (idempotent ueber session_key),
// optional Paket-Inventar-Delta. Antwort mit Kontingent-Zustand und
// exceptions_version fuer den Klienten-Cache.
// --------------------------------------------------------
router.post('/tracker/sync', (req, res) => {
  try {
    const d = db.get();
    const device = trackerDevice(req, res);
    if (!device) return undefined;

    const body = req.body ?? {};
    const sessions = Array.isArray(body.sessions) ? body.sessions : null;
    const inventory = body.inventory_delta === undefined || body.inventory_delta === null
      ? []
      : (Array.isArray(body.inventory_delta) ? body.inventory_delta : null);
    if (!sessions || !inventory) {
      return res.status(400).json({
        error: 'Body: { sessions: [...], inventory_delta?: [...] } with arrays.', code: 400, reason: 'media_time_bad_request',
      });
    }
    if (sessions.length > MAX_SESSIONS_PER_SYNC) {
      return res.status(400).json({
        error: `At most ${MAX_SESSIONS_PER_SYNC} sessions per call.`, code: 400, reason: 'media_time_bad_request',
      });
    }

    const dayKey = mediaTimeDayKey(d);
    const now = isoNow();
    let accepted = 0;
    const rejected = [];

    const insertSession = d.prepare(`
      INSERT INTO media_time_sessions
        (session_key, user_id, device_id, package_name, app_label, started_at, ended_at,
         used_minutes, minute_key, kind, system_component, classification, exception_rule_id,
         source, reported_by, created_at, updated_at)
      VALUES (@session_key, @user_id, @device_id, @package_name, @app_label, @started_at, @ended_at,
         @used_minutes, @minute_key, @kind, @system_component, @classification, @exception_rule_id,
         @source, @reported_by, @created_at, @updated_at)
    `);
    const touchSession = d.prepare(`
      UPDATE media_time_sessions
         SET used_minutes = @used_minutes, ended_at = @ended_at, updated_at = @updated_at
       WHERE device_id = @device_id AND session_key = @session_key
    `);
    const existingSession = d.prepare(`
      SELECT id, used_minutes, ended_at FROM media_time_sessions
       WHERE device_id = ? AND session_key = ?
    `);
    const upsertInventory = d.prepare(`
      INSERT INTO media_time_device_inventory
        (device_id, package_name, version_name, system_app, first_seen_at, last_seen_at, first_install_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, package_name) DO UPDATE SET
        version_name = COALESCE(excluded.version_name, version_name),
        system_app = excluded.system_app,
        last_seen_at = excluded.last_seen_at,
        first_install_estimate = COALESCE(excluded.first_install_estimate, first_install_estimate)
    `);

    const runAll = d.transaction(() => {
      for (const raw of sessions) {
        const key = typeof raw?.session_key === 'string' ? raw.session_key.trim() : '';
        if (!key || key.length > 200) {
          rejected.push({ session_key: key || null, reason: 'media_time_bad_request' });
          continue;
        }
        const packageName = typeof raw.package === 'string' && raw.package.trim() ? raw.package.trim().slice(0, 200) : null;
        const startedAt = typeof raw.started_at === 'string' ? raw.started_at : null;
        if (!startedAt) {
          rejected.push({ session_key: key, reason: 'media_time_bad_request' });
          continue;
        }
        const endedAt = typeof raw.ended_at === 'string' && raw.ended_at ? raw.ended_at : null;
        let usedMinutes = toInt(raw.foreground_ms != null
          ? Math.floor(Number(raw.foreground_ms) / 60000)
          : raw.used_minutes);
        if (!Number.isFinite(usedMinutes) || usedMinutes < 0) usedMinutes = 0;
        // Laufendes Segment: Ende auf jetzt kappen, damit ein Geraet mit
        // stillstehendem Timer kein Kontingent stapelt (> 12 h => kappt).
        if (!endedAt) usedMinutes = Math.min(usedMinutes, STALE_SESSION_CAP_MIN);
        else usedMinutes = Math.min(usedMinutes, 24 * 60);
        const kind = ['foreground', 'screen_on', 'service'].includes(raw.kind) ? raw.kind : 'foreground';
        const systemComponent = raw.system === 1 || raw.system === true || raw.system_component === 1 ? 1 : 0;

        const { classification, ruleId } = classifySession(d, device.user_id, {
          packageName, systemComponent,
        });
        const existing = existingSession.get(device.id, key);
        if (existing) {
          // Idempotente Nachmeldung: hoherer Stand gewinnt, Klassifikation
          // wird erneut gefragt (Ausnahmen koennen sich geaendert haben).
          const minutes = Math.max(existing.used_minutes, usedMinutes);
          touchSession.run({
            device_id: device.id, session_key: key,
            used_minutes: minutes,
            ended_at: endedAt ?? existing.ended_at,
            updated_at: now,
          });
          if (classification !== null) {
            d.prepare('UPDATE media_time_sessions SET classification = ?, exception_rule_id = ? WHERE id = ?')
              .run(classification, ruleId, existing.id);
          }
          accepted += 1;
          continue;
        }
        insertSession.run({
          session_key: key,
          user_id: device.user_id,
          device_id: device.id,
          package_name: packageName,
          app_label: typeof raw.app_label === 'string' ? raw.app_label.slice(0, 200) : null,
          started_at: startedAt,
          ended_at: endedAt,
          used_minutes: usedMinutes,
          minute_key: dayKey,
          kind,
          system_component: systemComponent,
          classification,
          exception_rule_id: ruleId,
          source: 'apk',
          reported_by: device.user_id,
          created_at: now,
          updated_at: null,
        });
        accepted += 1;
      }
      for (const item of inventory) {
        const pkg = typeof item?.package === 'string' && item.package.trim() ? item.package.trim().slice(0, 200) : null;
        if (!pkg) continue;
        upsertInventory.run(
          device.id, pkg,
          typeof item.version_name === 'string' ? item.version_name.slice(0, 100) : null,
          item.system_app ? 1 : 0,
          now, now,
          typeof item.first_install_estimate === 'string' ? item.first_install_estimate : null,
        );
      }
      d.prepare('UPDATE media_time_devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
    });
    runAll();

    const state = quotaState(d, device.user_id);
    return res.json({
      data: {
        accepted,
        rejected,
        server_day: state.day,
        server_time: now,
        quota: {
          remaining_min: state.remaining_min,
          used_min: state.used_min,
          quota_min: state.quota_min,
          quiet_active: state.quiet_active,
          state: state.state,
        },
        exceptions_version: exceptionsVersion(d),
      },
    });
  } catch (err) {
    log.error('POST /tracker/sync error:', err);
    return res.status(500).json({ error: 'Failed to sync media time.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /tracker/heartbeat — laufendes Segment verlaengern (idempotent ueber
// session_key). Ein Heartbeat ohne bekannte Session legt sie an.
// --------------------------------------------------------
router.post('/tracker/heartbeat', (req, res) => {
  try {
    const d = db.get();
    const device = trackerDevice(req, res);
    if (!device) return undefined;

    const key = typeof req.body?.session_key === 'string' ? req.body.session_key.trim() : '';
    if (!key || key.length > 200) {
      return res.status(400).json({
        error: 'session_key is required.', code: 400, reason: 'media_time_bad_request',
      });
    }
    const nowDate = new Date();
    const now = isoNow();
    let usedMinutes = toInt(req.body?.used_minutes);
    if (!Number.isFinite(usedMinutes) || usedMinutes < 0) usedMinutes = 0;
    usedMinutes = Math.min(usedMinutes, STALE_SESSION_CAP_MIN);

    const existing = d.prepare(
      'SELECT id, used_minutes FROM media_time_sessions WHERE device_id = ? AND session_key = ?',
    ).get(device.id, key);
    if (existing) {
      d.prepare('UPDATE media_time_sessions SET used_minutes = ?, updated_at = ? WHERE id = ?')
        .run(Math.max(existing.used_minutes, usedMinutes), now, existing.id);
    } else {
      const packageName = typeof req.body?.package === 'string' && req.body.package.trim()
        ? req.body.package.trim().slice(0, 200) : null;
      const { classification, ruleId } = classifySession(d, device.user_id, { packageName, systemComponent: 0 });
      d.prepare(`
        INSERT INTO media_time_sessions
          (session_key, user_id, device_id, package_name, started_at, used_minutes, minute_key,
           classification, exception_rule_id, source, reported_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'apk', ?, ?, ?)
      `).run(key, device.user_id, device.id, packageName, now, usedMinutes,
        mediaTimeDayKey(d, nowDate), classification, ruleId, device.user_id, now, now);
    }
    d.prepare('UPDATE media_time_devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);

    const state = quotaState(d, device.user_id, nowDate);
    return res.json({
      data: {
        ok: true,
        quota: {
          remaining_min: state.remaining_min,
          used_min: state.used_min,
          quota_min: state.quota_min,
          quiet_active: state.quiet_active,
          state: state.state,
        },
      },
    });
  } catch (err) {
    log.error('POST /tracker/heartbeat error:', err);
    return res.status(500).json({ error: 'Failed to record heartbeat.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /tracker/exceptions — aktive Ausnahmen (Verwaltung + Klienten-Cache).
// PUT  /tracker/exceptions — { upsert: [...], revoke: [id, ...] }
// Nur Eltern/Admin (media_manage).
// --------------------------------------------------------
router.get('/tracker/exceptions', requireManager, (req, res) => {
  try {
    const d = db.get();
    const userId = toInt(req.query.user_id);
    const rows = Number.isInteger(userId) && userId > 0
      ? activeExceptionRules(d, userId)
      : d.prepare('SELECT * FROM media_time_app_exceptions WHERE revoked_at IS NULL').all();
    return res.json({
      data: {
        items: rows.map((r) => ({
          id: r.id,
          user_id: r.user_id,
          match_type: r.match_type,
          pattern: r.pattern,
          exempt_from: r.exempt_from,
          note: r.note,
          created_at: r.created_at,
        })),
        version: exceptionsVersion(d),
      },
    });
  } catch (err) {
    log.error('GET /tracker/exceptions error:', err);
    return res.status(500).json({ error: 'Failed to read exceptions.', code: 500 });
  }
});

function validExceptionInput(item) {
  if (!item || typeof item !== 'object') return false;
  if (!['exact', 'prefix', 'glob'].includes(item.match_type)) return false;
  if (typeof item.pattern !== 'string' || !item.pattern.trim() || item.pattern.length > MAX_PATTERN_LENGTH) return false;
  if (item.pattern.trim() === YUVOMI_PACKAGE) return false; // hart ausgenommen, nicht umkehrbar
  if (!['quota', 'history', 'charged'].includes(item.exempt_from ?? 'quota')) return false;
  if (item.note !== undefined && item.note !== null && (typeof item.note !== 'string' || item.note.length > MAX_NOTE_LENGTH)) return false;
  if (item.user_id !== undefined && item.user_id !== null && !(Number.isInteger(item.user_id) && item.user_id > 0)) return false;
  return true;
}

router.put('/tracker/exceptions', requireManager, (req, res) => {
  try {
    const d = db.get();
    const upsert = req.body?.upsert === undefined ? [] : req.body.upsert;
    const revoke = req.body?.revoke === undefined ? [] : req.body.revoke;
    if (!Array.isArray(upsert) || !Array.isArray(revoke)) {
      return res.status(400).json({
        error: 'Body: { upsert?: [...], revoke?: [id, ...] } with arrays.', code: 400, reason: 'media_time_bad_request',
      });
    }
    const touchedUsers = new Set();
    const runAll = d.transaction(() => {
      for (const item of upsert) {
        if (!validExceptionInput(item)) {
          const e = new Error('Invalid exception rule.');
          e.statusCode = 400;
          e.reason = 'media_time_bad_request';
          throw e;
        }
        if (item.user_id != null) {
          const refusal = childRefusal(d, item.user_id);
          if (refusal) {
            const e = new Error(refusal.error);
            e.statusCode = refusal.status;
            e.reason = refusal.reason;
            throw e;
          }
        }
        const exemptFrom = item.exempt_from ?? 'quota';
        const info = d.prepare(`
          INSERT INTO media_time_app_exceptions (user_id, match_type, pattern, exempt_from, note, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, match_type, pattern) DO UPDATE SET
            exempt_from = excluded.exempt_from,
            note = excluded.note,
            revoked_at = NULL
        `).run(
          item.user_id ?? null, item.match_type, item.pattern.trim(), exemptFrom,
          item.note ?? null, actingUser(req), isoNow(),
        );
        if (item.user_id != null) touchedUsers.add(item.user_id);
        else {
          for (const child of d.prepare("SELECT id FROM users WHERE family_role = 'child'").all()) {
            touchedUsers.add(child.id);
          }
        }
        void info;
      }
      for (const id of revoke) {
        const num = toInt(id);
        if (!Number.isInteger(num) || num <= 0) continue;
        const row = d.prepare('SELECT id, user_id FROM media_time_app_exceptions WHERE id = ? AND revoked_at IS NULL').get(num);
        if (!row) continue;
        d.prepare('UPDATE media_time_app_exceptions SET revoked_at = ? WHERE id = ?').run(isoNow(), num);
        if (row.user_id != null) touchedUsers.add(row.user_id);
        else {
          for (const child of d.prepare("SELECT id FROM users WHERE family_role = 'child'").all()) {
            touchedUsers.add(child.id);
          }
        }
      }
      // Klassifikation neu berechnen: Aenderung rueckt keine Rohdaten zurecht,
      // sie fragt nur erneut, welche Regel greift (adjust-Philosophie).
      for (const uid of touchedUsers) reclassifyForUser(d, uid);
    });
    try {
      runAll();
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({
          error: err.message, code: err.statusCode, reason: err.reason ?? 'media_time_bad_request',
        });
      }
      throw err;
    }
    return res.json({ data: { version: exceptionsVersion(d) } });
  } catch (err) {
    log.error('PUT /tracker/exceptions error:', err);
    return res.status(500).json({ error: 'Failed to update exceptions.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /today?user_id= — was das Kind (oder ein Elternteil) heute sieht.
// charged_min / exempt_min / unknown_min + tracker:{last_seen_at, online}.
// --------------------------------------------------------
router.get('/today', (req, res) => {
  try {
    const d = db.get();
    const actor = actingUser(req);
    if (!actor) {
      return res.status(401).json({ error: 'Authentication required.', code: 401, reason: 'media_time_unauthenticated' });
    }
    const requested = req.query.user_id !== undefined ? toInt(req.query.user_id) : actor;
    if (!Number.isInteger(requested) || requested <= 0) {
      return res.status(400).json({ error: 'user_id must be an integer.', code: 400, reason: 'media_time_bad_request' });
    }
    if (requested !== actor && !isParentOrAdmin(req)) {
      return res.status(403).json({
        error: 'Only parents can read another child.', code: 403, reason: 'media_time_forbidden',
      });
    }
    const target = d.prepare('SELECT id, family_role FROM users WHERE id = ?').get(requested);
    if (!target) return res.status(404).json({ error: 'User not found.', code: 404 });

    const state = quotaState(d, requested);
    const tracker = trackerStatus(d, requested);
    const rate = mediaTimeExchangeRate(d);
    return res.json({
      data: {
        user_id: requested,
        day: state.day,
        enabled: mediaTimeEnabled(d),
        quota_min: state.quota_min,
        used_min: state.used_min,
        remaining_min: state.remaining_min,
        charged_min: state.charged_min,
        exempt_min: state.exempt_min,
        unknown_min: state.unknown_min,
        purchased_min: state.purchased_min,
        max_daily_minutes: state.max_daily_minutes,
        hard_cap: state.hard_cap,
        // Die globale Ruhezeit ist fuer ALLE im Haushalt sichtbar (Entscheidung
        // 8): 'Ruhezeit aktiv - noch X Min' als Signal, nicht als Zwang.
        quiet: mediaTimeQuietWindow(d),
        quiet_active: state.quiet_active,
        exchange: rate ? { points: rate.points, minutes: rate.minutes } : null,
        state: state.state,
        wall_time: householdWallTime(d),
        tracker: { last_seen_at: tracker.last_seen_at, online: tracker.online },
      },
    });
  } catch (err) {
    log.error('GET /today error:', err);
    return res.status(500).json({ error: 'Failed to read today.', code: 500 });
  }
});

// --------------------------------------------------------
// Quotas: GET /quotas?user_id=, PUT /quotas/:userId (Eltern/Admin)
// --------------------------------------------------------
router.get('/quotas', requireManager, (req, res) => {
  try {
    const d = db.get();
    const requested = req.query.user_id !== undefined ? toInt(req.query.user_id) : null;
    if (requested != null) {
      const refusal = childRefusal(d, requested);
      if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.status, reason: refusal.reason });
      return res.json({ data: [quotaRow(d, requested) ?? { user_id: requested, daily_minutes: 0, enabled: 1, quota_min: 0 }] });
    }
    const rows = d.prepare(`
      SELECT q.*, u.display_name, u.username
      FROM media_time_quotas q
      JOIN users u ON u.id = q.user_id
      WHERE u.family_role = 'child'
      ORDER BY u.username
    `).all();
    return res.json({ data: rows });
  } catch (err) {
    log.error('GET /quotas error:', err);
    return res.status(500).json({ error: 'Failed to read quotas.', code: 500 });
  }
});

router.put('/quotas/:userId', requireManager, (req, res) => {
  try {
    const d = db.get();
    const userId = toInt(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'userId must be an integer.', code: 400, reason: 'media_time_bad_request' });
    }
    const refusal = childRefusal(d, userId);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.status, reason: refusal.reason });

    const body = req.body ?? {};
    const daily = body.daily_minutes === undefined ? 0 : toInt(body.daily_minutes);
    if (!Number.isInteger(daily) || daily < 0 || daily > 1440) {
      return res.status(400).json({
        error: 'daily_minutes must be 0..1440.', code: 400, reason: 'media_time_bad_request',
      });
    }
    let maxDaily = body.max_daily_minutes === undefined || body.max_daily_minutes === null
      ? null : toInt(body.max_daily_minutes);
    if (maxDaily !== null && (!Number.isInteger(maxDaily) || maxDaily < 0 || maxDaily > 1440)) {
      return res.status(400).json({
        error: 'max_daily_minutes must be 0..1440 or null.', code: 400, reason: 'media_time_bad_request',
      });
    }
    // Der Punktetausch hat EINEN Kurs fuer den ganzen Haushalt (Entscheidung 2:
    // 'ein Kurs fuer alle') - die quota-Zeile kennt keine Kurs-Spalten.
    const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);

    d.prepare(`
      INSERT INTO media_time_quotas
        (user_id, daily_minutes, max_daily_minutes, enabled, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        daily_minutes = excluded.daily_minutes,
        max_daily_minutes = excluded.max_daily_minutes,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(userId, daily, maxDaily, enabled, isoNow(), actingUser(req));

    return res.json({ data: quotaRow(d, userId) });
  } catch (err) {
    log.error('PUT /quotas/:userId error:', err);
    return res.status(500).json({ error: 'Failed to save quota.', code: 500 });
  }
});

// --------------------------------------------------------
// Quiet-Hours (Praeferenz, Praeferenz-Stil wie rewards_penalties_enabled):
// GET /quiet-hours, PUT /quiet-hours { range: 'HH:MM-HH:MM' | null }
// --------------------------------------------------------
router.get('/quiet-hours', (req, res) => {
  try {
    const d = db.get();
    const window = mediaTimeQuietWindow(d);
    return res.json({
      data: {
        enabled: !!window,
        range: window ? `${window.from}-${window.to}` : null,
        // Globale Ruhezeit: dieselbe Antwort fuer jedes Haushaltsmitglied
        // (Entscheidung 8), deshalb ohne user_id abgeleitet.
        active_now: window ? quietWindowActive(d) : false,
      },
    });
  } catch (err) {
    log.error('GET /quiet-hours error:', err);
    return res.status(500).json({ error: 'Failed to read quiet hours.', code: 500 });
  }
});

router.put('/quiet-hours', requireManager, (req, res) => {
  try {
    const d = db.get();
    const raw = req.body?.range;
    let value = null;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string') {
        return res.status(400).json({
          error: 'range must be "HH:MM-HH:MM" or null.', code: 400, reason: 'media_time_bad_request',
        });
      }
      const parsed = parseQuietHours(raw);
      if (!parsed) {
        return res.status(400).json({
          error: 'range must be "HH:MM-HH:MM" or null.', code: 400, reason: 'media_time_bad_request',
        });
      }
      value = `${parsed.from}-${parsed.to}`;
    }
    d.prepare(`
      INSERT INTO sync_config (key, value) VALUES ('media_time_quiet_hours_global', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(value ?? '');
    return res.json({ data: { enabled: value !== null, range: value } });
  } catch (err) {
    log.error('PUT /quiet-hours error:', err);
    return res.status(500).json({ error: 'Failed to save quiet hours.', code: 500 });
  }
});

// --------------------------------------------------------
// Haushalt-Einstellungen der Medienzeit (Admin/Eltern): Schalter
// media_time_enabled liegt bei PUT /preferences (Muster
// rewards_penalties_enabled); hier der Tauschkurs (global, Entscheidung 2)
// und die Cap-Haertheit (Entscheidung 4, Default hart).
// --------------------------------------------------------
router.get('/settings', (req, res) => {
  try {
    const d = db.get();
    const rate = mediaTimeExchangeRate(d);
    return res.json({
      data: {
        enabled: mediaTimeEnabled(d),
        exchange: rate ? { points: rate.points, minutes: rate.minutes } : null,
        hard_cap: mediaTimeHardCap(d),
        retention_days: RAW_RETENTION_DAYS,
      },
    });
  } catch (err) {
    log.error('GET /settings error:', err);
    return res.status(500).json({ error: 'Failed to read media time settings.', code: 500 });
  }
});

router.put('/settings', requireManager, (req, res) => {
  try {
    const d = db.get();
    const cfgSet = (key, value) => d.prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(key, value);
    const { exchange, hard_cap } = req.body ?? {};
    if (exchange !== undefined) {
      if (exchange === null || exchange === '') {
        cfgSet('media_time_exchange_rate', '');
      } else if (typeof exchange === 'string') {
        const parsed = parseExchangeRate(exchange);
        if (!parsed) {
          return res.status(400).json({
            error: 'exchange must be "points:minutes" (e.g. "10:15") or null.',
            code: 400, reason: 'media_time_bad_request',
          });
        }
        cfgSet('media_time_exchange_rate', `${parsed.points}:${parsed.minutes}`);
      } else if (exchange && typeof exchange === 'object') {
        const points = toInt(exchange.points);
        const minutes = toInt(exchange.minutes);
        if (!Number.isInteger(points) || points < 1 || points > 9999
          || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
          return res.status(400).json({
            error: 'exchange needs integer points (>=1) and minutes (1..1440), or null.',
            code: 400, reason: 'media_time_bad_request',
          });
        }
        cfgSet('media_time_exchange_rate', `${points}:${minutes}`);
      } else {
        return res.status(400).json({
          error: 'exchange must be "points:minutes", {points, minutes} or null.',
          code: 400, reason: 'media_time_bad_request',
        });
      }
    }
    if (hard_cap !== undefined) {
      if (typeof hard_cap !== 'boolean') {
        return res.status(400).json({
          error: 'hard_cap must be a boolean', code: 400, reason: 'media_time_bad_request',
        });
      }
      cfgSet('media_time_hard_cap', hard_cap ? '1' : '0');
    }
    const rate = mediaTimeExchangeRate(d);
    return res.json({
      data: {
        enabled: mediaTimeEnabled(d),
        exchange: rate ? { points: rate.points, minutes: rate.minutes } : null,
        hard_cap: mediaTimeHardCap(d),
      },
    });
  } catch (err) {
    log.error('PUT /settings error:', err);
    return res.status(500).json({ error: 'Failed to save media time settings.', code: 500 });
  }
});

// --------------------------------------------------------
// Punkte->Minuten-Tausch. Der Kurs ist GLOBAL pro Haushalt (Entscheidung 2:
// ein Kurs fuer alle) - Praeferenz media_time_exchange_rate ('points:minutes',
// z. B. '10:15'; leer = Tausch aus). Gebucht wird UBER das Punkte-Ledger
// (dieselbe Wahrung, kein zweites Punktesystem, reason 'media_time:<id>').
// Der Kauf schreibt eine credit-Session (source 'adjust'), die das Kontingent
// des Tages erhoeht, damit die Historie ihn als eigene Zeile zeigt.
// --------------------------------------------------------
router.post('/purchase', (req, res) => {
  try {
    const d = db.get();
    const actor = actingUser(req);
    if (!actor) {
      return res.status(401).json({ error: 'Authentication required.', code: 401, reason: 'media_time_unauthenticated' });
    }
    const targetId = toInt(req.body?.user_id) || actor;
    if (targetId !== actor && !isParentOrAdmin(req)) {
      return res.status(403).json({
        error: 'Only parents can buy time for a child.', code: 403, reason: 'media_time_forbidden',
      });
    }
    const refusal = childRefusal(d, targetId);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.status, reason: refusal.reason });
    if (!mediaTimeEnabled(d)) {
      return res.status(403).json({
        error: 'Media time is not enabled for this household.', code: 403, reason: 'media_time_disabled',
      });
    }
    const quota = quotaRow(d, targetId);
    if (!quota || quota.enabled !== 1) {
      return res.status(400).json({
        error: 'This child has no media time quota.', code: 400, reason: 'media_time_no_quota',
      });
    }
    // EIN Kurs fuer den ganzen Haushalt (Entscheidung 2): media_time_exchange_rate
    // als Praeferenz ('points:minutes', z. B. '10:15'); leer = Tausch aus.
    const rate = mediaTimeExchangeRate(d);
    if (!rate) {
      return res.status(400).json({
        error: 'The point exchange is off for this household.', code: 400, reason: 'media_time_exchange_off',
      });
    }
    const quantity = req.body?.quantity === undefined ? 1 : toInt(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({
        error: 'quantity must be 1..100.', code: 400, reason: 'media_time_bad_request',
      });
    }
    const minutes = rate.minutes * quantity;
    const points = rate.points * quantity;

    // Cap (Entscheidung 4): hart = max_daily_minutes ist zu, auch gegen Punkte;
    // kaufbar ('0') = der Kauf darf bis zum Cap wachsen, ohne Cap offen.
    const stateNow = quotaState(d, targetId);
    if (quota.max_daily_minutes != null) {
      const cap = quota.max_daily_minutes;
      if (mediaTimeHardCap(d)) {
        if (stateNow.quota_min + minutes > cap) {
          return res.status(400).json({
            error: 'The hard daily cap does not allow this exchange.', code: 400, reason: 'media_time_cap_reached',
          });
        }
      } else if (stateNow.charged_min >= cap) {
        return res.status(400).json({
          error: 'The daily cap is already used up.', code: 400, reason: 'media_time_cap_reached',
        });
      }
    }

    const balance = d.prepare(
      "SELECT COALESCE(SUM(delta), 0) AS bal FROM reward_ledger WHERE user_id = ? AND unit = 'points'",
    ).get(targetId).bal;
    if (balance < points) {
      return res.status(400).json({
        error: 'The point balance does not cover the exchange.', code: 400, reason: 'media_time_insufficient_points',
      });
    }

    const dayKey = mediaTimeDayKey(d);
    const now = isoNow();
    const purchaseId = `mt-${crypto.randomUUID()}`;
    const runAll = d.transaction(() => {
      d.prepare(`
        INSERT INTO reward_ledger (user_id, delta, type, reason, created_by, unit)
        VALUES (?, ?, 'adjust', ?, ?, 'points')
      `).run(targetId, -points, `media_time:${purchaseId}`, actor);
      d.prepare(`
        INSERT INTO media_time_sessions
          (session_key, user_id, device_id, started_at, ended_at, used_minutes, minute_key,
           classification, source, reported_by, created_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, 'credit', 'adjust', ?, ?)
      `).run(`purchase:${purchaseId}`, targetId, now, now, minutes, dayKey, actor, now);
    });
    runAll();

    const state = quotaState(d, targetId);
    return res.status(201).json({
      data: {
        purchase_id: purchaseId,
        minutes,
        points_spent: points,
        quota: {
          remaining_min: state.remaining_min,
          used_min: state.used_min,
          quota_min: state.quota_min,
          state: state.state,
        },
      },
    });
  } catch (err) {
    log.error('POST /purchase error:', err);
    return res.status(500).json({ error: 'Failed to exchange points.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /purchases?user_id= — die Tausch-Historie eines Kindes (adjust-Zeilen).
// Das Kind sieht die eigenen, Eltern/Admin jede.
// --------------------------------------------------------
router.get('/purchases', (req, res) => {
  try {
    const d = db.get();
    const actor = actingUser(req);
    if (!actor) {
      return res.status(401).json({ error: 'Authentication required.', code: 401, reason: 'media_time_unauthenticated' });
    }
    const targetId = req.query.user_id !== undefined ? toInt(req.query.user_id) : actor;
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'user_id must be an integer.', code: 400, reason: 'media_time_bad_request' });
    }
    if (targetId !== actor && !isParentOrAdmin(req)) {
      return res.status(403).json({
        error: 'Only parents can read another child.', code: 403, reason: 'media_time_forbidden',
      });
    }
    const items = d.prepare(`
      SELECT session_key, minute_key, started_at, used_minutes, reported_by, created_at
      FROM media_time_sessions
      WHERE user_id = ? AND classification = 'credit'
      ORDER BY created_at DESC
      LIMIT 200
    `).all(targetId);
    return res.json({ data: { items } });
  } catch (err) {
    log.error('GET /purchases error:', err);
    return res.status(500).json({ error: 'Failed to read purchases.', code: 500 });
  }
});

// --------------------------------------------------------
// Gerate: Anlegen (einmaliger Klartext), List, Revoke. Eltern/Admin.
// Der Klartext des Tokens steht genau einmal in der Anlege-Antwort.
// --------------------------------------------------------
router.post('/devices', requireManager, (req, res) => {
  try {
    const d = db.get();
    const userId = toInt(req.body?.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'user_id must be an integer.', code: 400, reason: 'media_time_bad_request' });
    }
    const refusal = childRefusal(d, userId);
    if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.status, reason: refusal.reason });
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, MAX_NAME_LENGTH) : null;
    if (!name) {
      return res.status(400).json({ error: 'name is required (max 100 chars).', code: 400, reason: 'media_time_bad_request' });
    }
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.slice(0, 40) : null;
    const credential = 'mt_' + crypto.randomBytes(32).toString('base64url');
    const info = d.prepare(`
      INSERT INTO media_time_devices (user_id, name, platform, device_token_hash)
      VALUES (?, ?, ?, ?)
    `).run(userId, name, platform, hashDeviceToken(credential));
    return res.status(201).json({
      data: { id: info.lastInsertRowid, user_id: userId, name, token: credential, note: 'Store the token now - it is shown once.' },
    });
  } catch (err) {
    log.error('POST /devices error:', err);
    return res.status(500).json({ error: 'Failed to create device.', code: 500 });
  }
});

router.get('/devices', requireManager, (req, res) => {
  try {
    const d = db.get();
    const userId = req.query.user_id !== undefined ? toInt(req.query.user_id) : null;
    const rows = userId != null
      ? d.prepare('SELECT id, user_id, name, platform, last_seen_at, revoked_at, created_at FROM media_time_devices WHERE user_id = ? ORDER BY id').all(userId)
      : d.prepare('SELECT id, user_id, name, platform, last_seen_at, revoked_at, created_at FROM media_time_devices ORDER BY id').all();
    return res.json({ data: rows });
  } catch (err) {
    log.error('GET /devices error:', err);
    return res.status(500).json({ error: 'Failed to list devices.', code: 500 });
  }
});

router.post('/devices/:id/revoke', requireManager, (req, res) => {
  try {
    const d = db.get();
    const id = toInt(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be an integer.', code: 400, reason: 'media_time_bad_request' });
    }
    const info = d.prepare('UPDATE media_time_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(isoNow(), id);
    if (info.changes === 0) return res.status(404).json({ error: 'Device not found or already revoked.', code: 404 });
    return res.json({ data: { id, revoked: true } });
  } catch (err) {
    log.error('POST /devices/:id/revoke error:', err);
    return res.status(500).json({ error: 'Failed to revoke device.', code: 500 });
  }
});

// --------------------------------------------------------
// Paket-Inventar eines Gerats (Eltern-UI "neu installiert?").
// --------------------------------------------------------
router.get('/devices/:id/inventory', requireManager, (req, res) => {
  try {
    const d = db.get();
    const id = toInt(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'id must be an integer.', code: 400, reason: 'media_time_bad_request' });
    }
    const device = d.prepare('SELECT id FROM media_time_devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Device not found.', code: 404 });
    const items = d.prepare(`
      SELECT package_name, version_name, system_app, first_seen_at, last_seen_at, first_install_estimate
      FROM media_time_device_inventory WHERE device_id = ? ORDER BY package_name
    `).all(id);
    return res.json({ data: { items } });
  } catch (err) {
    log.error('GET /devices/:id/inventory error:', err);
    return res.status(500).json({ error: 'Failed to read inventory.', code: 500 });
  }
});

export default router;
