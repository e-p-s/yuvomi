/**
 * Modul: Family-Link-Anmeldung in der Oberflaeche (Medienzeit-Seite)
 * Zweck: Der Sammler liefert Daten, die Anmeldung soll der Mensch jederzeit
 *        aus der App heraus tun koennen - E-Mail, Passwort, zweiter Code.
 *        Diese Suite misst den Bau des Statusblocks: ruhige Zeile mit
 *        Anmelde-Knopf im gesunden Zustand, das Zugangsdaten-Formular auf
 *        Zuruf (erneut anmelden), der Code-Schritt nach otp_needed und der
 *        Rueckweg zur ruhigen Zeile. Verhalten, nicht Quelltextfantasie.
 * Ausführen: npm run test:media-time-fl-ui
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
import { installMiniDom } from './mini-dom.js';
installMiniDom();
globalThis.document.documentElement.classList = {
  toggle() {}, add() {}, remove() {}, contains() { return false; },
};
globalThis.window = globalThis.window ?? {};
globalThis.window.yuvomi = { showToast() {} };

const { __test } = await import('../public/pages/media-time.js');

const frisch = {
  familylink_status: 'ok',
  familylink_last_report_at: new Date().toISOString(),
  familylink_status_at: new Date().toISOString(),
  familylink_email: 'vater@example.invalid',
};
const abgelaufen = {
  familylink_status: 'login_noetig',
  familylink_last_report_at: new Date().toISOString(),
};

test('gesunder Zustand: ruhige Zeile mit Knopf, sich erneut anzumelden', () => {
  __test.setAuthMode('form');
  const html = __test.flStatusBlockHtml(frisch);
  assert.match(html, /data-action="mt-fl-relogin"/, 'der Anmelde-Knopf fehlt im gesunden Zustand');
  assert.doesNotMatch(html, /id="mt-fl-auth-form"/, 'das Formular steht nicht unaufgefordert im Raum');
});

test('erneut anmelden: das Zugangsdaten-Formular erscheint (E-Mail vorbesetzt, Passwort leer)', () => {
  __test.setAuthMode('relogin');
  const html = __test.flStatusBlockHtml(frisch);
  assert.match(html, /id="mt-fl-auth-form"/, 'das Formular fehlt nach dem Knopf');
  assert.match(html, /id="mt-fl-email"[^>]*value="vater@example\.invalid"/, 'die E-Mail kommt vorbesetzt');
  assert.doesNotMatch(html, /id="mt-fl-password"[^>]*value=/, 'ins Passwortfeld schreibt nichts');
  assert.match(html, /data-action="mt-fl-relogin-cancel"/, 'der Rueckweg fehlt');
  __test.setAuthMode('form');
  assert.match(__test.flStatusBlockHtml(frisch), /data-action="mt-fl-relogin"/, 'zurueck steht wieder die ruhige Zeile');
});

test('otp_needed: der zweite Schritt zeigt das Codefeld, nicht das Passwortfeld', () => {
  __test.setAuthMode('otp');
  const html = __test.flStatusBlockHtml(frisch);
  assert.match(html, /id="mt-fl-code"/, 'das Codefeld fehlt');
  assert.doesNotMatch(html, /id="mt-fl-password"/, 'das Passwortfeld ist weg');
  __test.setAuthMode('form');
});

test('abgelaufener Zustand: das Formular steht ohne Zuruf bereit', () => {
  __test.setAuthMode('form');
  const html = __test.flStatusBlockHtml(abgelaufen);
  assert.match(html, /id="mt-fl-auth-form"/, 'bei Anmeldung-noetig fehlt das Formular');
  assert.match(html, /id="mt-fl-email"/, 'E-Mail-Feld fehlt');
  assert.match(html, /id="mt-fl-password"/, 'Passwortfeld fehlt');
});
