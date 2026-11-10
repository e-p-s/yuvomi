/**
 * Fernlogin fuer den Family-Link-Sammler (Viewer-Sitzung).
 *
 * Zweck: der Sammler-Host (CT122, einziger Rechner mit Chromium-Profil) hat
 * keine Google-Sitzung mehr, wenn der 401-Fall eintritt. Statt dass jemand vor
 * Ort tippt, oeffnet die Eltern-UI eine Fernlogin-Sitzung: der Beistandsdienst
 * scripts/familylink/familylink_login_proxy.py auf dem Sammler haelt den
 * Browser-Bildschirm als Viewer-Seite bereit und leitet Eingaben zurueck.
 * Dieser Dienst baut die Sitzung auf: Token erzeugen, dem Collector
 * mitteilen (Bearer-Freigabegeheimnis), Viewer-URL zurueckgeben.
 *
 * Konfiguration (env, Deploy-Sache - nie hartkodiert):
 *   FAMILYLINK_COLLECTOR_BASE   z.B. http://172.30.20.200:9334 (Collector-Host)
 *   FAMILYLINK_LOGIN_SECRET     derselbe Inhalt wie ~/.familyhub/login_secret
 *                               auf dem Sammler (Datei mit 0600, nie ins Repo)
 *
 * Grundregeln:
 * - Das Login-Geheimnis liegt nur im Request-Header an den Collector, nie in
 *   der Antwort an die App; die Viewer-URL traegt das Einmal-Sitzungs-Token.
 * - doppelte Starts: die alte Sitzung wird vorher best effort storniert
 *   (POST /login/cancel am Collector), damit nie zwei Viewer laufen.
 * - TTL: 10 Minuten, harte Obergrenze des Collectors 15 Minuten - abgelaufene
 *   Sitzungen geraeumt werden beim Collector, hier lebt nur der Plan nach.
 * - Der Token-Vergleich auf Collector-Seite ist zeitkonstant (Python-Zweig);
 *   hier geht es nur um den Aufbau, nicht um die Authentifizierung.
 *
 * Ausfuehren der Suite: npm run test:familylink-routes
 */

import crypto from 'node:crypto';

const SESSION_TTL_MS = 10 * 60_000; // Auftrag: 10 Minuten gueltig
const HARD_MAX_TTL_MS = 15 * 60_000; // harte Grenze des Collectors

/** Die eine aktive Sitzung (mehr haelt der Collector ohnehin nicht). */
let current = null;

// Test-Haendler wie in server/services/holidays.js: die Route ruft den Dienst,
// der Test setzt den fetch-Hook, ohne die HTTP-Schicht zu verlassen.
const nativeFetch = fetch;
let fetchImpl = nativeFetch;
export function __setFetchImpl(fn) { fetchImpl = fn ?? nativeFetch; }

/** Stand der aktiven Sitzung (fuer Tests und Spaeter); null ohne jede. */
export function currentLoginSession() {
  return current ? { ...current } : null;
}

/** Fuer Tests: die In-Memory-Sitzung vergessen (kein Collector-Ruf). */
export function __resetLoginSession() { current = null; }

/**
 * Eine Fernlogin-Sitzung starten (Elternpfad, Rate-Limit sitzt an der Route).
 * @returns {Promise<{ok: true, viewer_url: string, expires_at: string} |
 *   {ok: false, status: number, reason: string}>}
 */
export async function startFamilylinkLoginSession() {
  const base = String(process.env.FAMILYLINK_COLLECTOR_BASE || '').trim().replace(/\/+$/, '');
  const secret = String(process.env.FAMILYLINK_LOGIN_SECRET || '').trim();
  if (!base || !secret) {
    return { ok: false, status: 503, reason: 'media_time_familylink_not_configured' };
  }
  // Doppelte Starts: alte Session stornieren und neue starten - best effort,
  // ein nicht erreichbarer Cancel kostet hoestens die alte TTL beim Collector.
  if (current) {
    try {
      await fetchImpl(`${base}/login/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${secret}` },
      });
    } catch { /* best effort */ }
  }
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = Math.min(SESSION_TTL_MS, HARD_MAX_TTL_MS);
  const expiresAt = new Date(Date.now() + ttl).toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const res = await fetchImpl(`${base}/login/start`, {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ session_token: token, expires_at: expiresAt }),
    });
    if (!res.ok) {
      return { ok: false, status: 502, reason: 'media_time_familylink_collector_unreachable' };
    }
  } catch {
    return { ok: false, status: 502, reason: 'media_time_familylink_collector_unreachable' };
  }
  current = { expires_at: expiresAt, started_at: isoNow() };
  return {
    ok: true,
    viewer_url: `${base}/login/view?t=${token}`,
    expires_at: expiresAt,
  };
}

/**
 * Der Auto-Login-Pfad (POST {base}/login/auto): der Collector fuellt den
 * Google-Login selbst aus (E-Mail+Passwort) und fuehrt eine pending-Sitzung,
 * die ein zweiter Aufruf mit {code} auf der OTP-Seite fortsetzt. Das Passwort
 * geht NUR im Request-Header/Body an den Collector — es wird nie geloggt und
 * die Antwort enthaelt ausschliesslich das Ergebnis-Wort. Ungueltige
 * Collector-Antworten (kein bekanntes result)zaehlen wie unerreichbar.
 * @returns {Promise<{ok: true, result: 'ok'|'otp_needed'|'bad_code'|'bad_password'|'challenge'} |
 *   {ok: false, status: number, reason: string}>}
 */
export async function postFamilylinkLogin({ email, password, code } = {}) {
  const base = String(process.env.FAMILYLINK_COLLECTOR_BASE || '').trim().replace(/\/+$/, '');
  const secret = String(process.env.FAMILYLINK_LOGIN_SECRET || '').trim();
  if (!base || !secret) {
    return { ok: false, status: 503, reason: 'media_time_familylink_not_configured' };
  }
  const body = {};
  if (typeof email === 'string' && email) body.email = email;
  if (typeof password === 'string' && password) body.password = password;
  if (typeof code === 'string' && code) body.code = code;
  let res;
  try {
    res = await fetchImpl(`${base}/login/auto`, {
      method: 'POST',
      signal: AbortSignal.timeout(90000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 502, reason: 'media_time_familylink_collector_unreachable' };
  }
  if (!res.ok) {
    return { ok: false, status: 502, reason: 'media_time_familylink_collector_unreachable' };
  }
  let result = null;
  try {
    result = (await res.json())?.result ?? null;
  } catch {
    result = null;
  }
  // Der Collector meldet eine geschlossene pending (abgelaufen oder nach
  // bad_password geschlossen): die App muss mit E-Mail+Passwort neu ansetzen.
  if (result === 'no_pending') {
    return { ok: false, status: 422, reason: 'media_time_familylink_login_expired' };
  }
  if (!['ok', 'otp_needed', 'bad_code', 'bad_password', 'challenge'].includes(result)) {
    return { ok: false, status: 502, reason: 'media_time_familylink_collector_unreachable' };
  }
  return { ok: true, result };
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
