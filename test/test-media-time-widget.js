/**
 * Test: Medienzeit-Kachel auf der Uebersicht (renderMediaTimeWidget)
 * Zweck: Die Kachel zeigt pro Kind den Balken des Tageskontingents aus dem
 *        /today-Endpunkt (Eltern-Session): Rest, Anpassung (adjusted_min) und
 *        Begruendung (reason) in der Zeile; adjusted_min fehlt = keine Zeile;
 *        Leerzustand nur fuer Eltern ohne Kind mit Kontingent; ein Kind ohne
 *        eigene Antwort wirft (Fehlerkachel, nicht Leerzustand). Der Schalter
 *        utils/media-time-dashboard.js ist geratelokal: Standard AN, nur die
 *        explizite '0' blendet aus.
 * Muster: test/test-dashboard-rewards.js - loader-Stubs, __test-Direktaufruf.
 * Ausfuehren: node --loader ./test/test-browser-loader.mjs --test test/test-media-time-widget.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./test-browser-loader.mjs', import.meta.url);

global.window ??= { yuvomi: null };
// Echte de-Template fuer die Zeile (der Loader-Stub uebersetzt ueber
// globalThis.__tDict). Der Stub-Platzhalter-Ersatz ist auf die Vorlage des
// Intervall-Satzes kalibriert und laeuft hier ins Leerzeichen hinter der Zahl -
// die Assertions vergleichen deshalb gegen das Template selbst, nicht gegen
// seine eingesetzte Form.
const escT = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
globalThis.__tDict = {
  'dashboard.mediaTimeRest': 'noch {{remaining}} von {{quota}} Min',
  'dashboard.mediaTimeAdjustPlus': '+{{minutes}} Min heute',
  'mediaTime.remainingOfQuota': 'noch {{remaining}} von {{quota}} Min uebrig',
};
global.localStorage ??= {
  _s: new Map(),
  getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k, v) { this._s.set(k, String(v)); },
  removeItem(k) { this._s.delete(k); },
};

const { __test } = await import('../public/pages/dashboard.js');
const { renderMediaTimeWidget, mediaTimeTone } = __test;

const row = (over = {}) => ({
  id: 7,
  display_name: 'Luis',
  today: { enabled: true, state: 'ok', quota_min: 60, remaining_min: 45, adjusted_min: 0, reason: null, ...over },
});

test('Kachel: Zeile je Kind mit Rest, Balken und Route auf die Medienzeit-Seite', () => {
  const html = renderMediaTimeWidget({ manager: true, failed: 0, children: [row()] }, '1x2');
  assert.match(html, /widget--media-time/, 'die Kachel trgt ihre Klasse');
  assert.match(html, /Luis/, 'der Name des Kindes steht in der Zeile');
  assert.match(html, /role="progressbar"/, 'der Balken ist eine Progressbar');
  assert.match(html, /aria-valuemax="60"/, 'die Skala kommt aus dem Kontingent');
  assert.match(html, /data-route="\/media-time\?user_id=7"/, 'Eltern springen aufs Kind voraus');
  assert.ok(html.includes(escT('noch {{remaining}} von {{quota}} Min')), 'der Rest steht als Satz in der Zeile');
});

test('Kachel: Anpassung und Begruendung stehen in der Zeile, der Ton spricht an der Zahl', () => {
  const html = renderMediaTimeWidget({
    manager: true, failed: 0,
    children: [row({ adjusted_min: 15, reason: 'Geburtstag', remaining_min: 5 })],
  }, '1x2');
  assert.ok(html.includes(escT('+{{minutes}} Min heute')), 'die Anpassung nennt, dass der Tag nicht beim Basiswert liegt');
  assert.match(html, /Geburtstag/, 'die Begruendung sehen Kinder ohne Klick');
  assert.match(html, /media-time-widget-row--nearing/, 'unter einem Viertel uebrig: der Ton der Zahl');
});

test('Kachel: fehlendes adjusted_min ist keine Zeile (ein Server vor der Anpassung)', () => {
  const t = row();
  delete t.today.adjusted_min;
  const html = renderMediaTimeWidget({ manager: true, failed: 0, children: [t] }, '1x2');
  assert.doesNotMatch(html, /Min heute/, 'ohne Feld erfindet die Kachel keine Anpassung');
});

test('Kachel: Leerzustand nur fuer Eltern ohne Kind mit Kontingent', () => {
  const html = renderMediaTimeWidget({ manager: true, failed: 0, children: [] }, '1x2');
  assert.match(html, /mediaTimeEmpty|Heute hat noch kein Kind ein Kontingent/, 'der Leerzustand ist der ruhige Satz');
});

test('Kachel: ein Kind ohne eigene Antwort wirft - die Fehlerkachel sagt es, nicht die leere Liste', () => {
  assert.throws(() => renderMediaTimeWidget({ manager: false, failed: 1, children: [] }, '1x2'),
    /no own answer|failed to load/, 'kein Kind ohne Auskunft ist keine leere Liste');
  assert.equal(renderMediaTimeWidget(undefined, '1x2'), '', 'nie geladen = nichts zu behaupten');
});

test('Kachel: mediaTimeTone - exceeded, nearing, off, ok', () => {
  assert.equal(mediaTimeTone(row({ state: 'exceeded', remaining_min: 0 })), 'exceeded');
  assert.equal(mediaTimeTone(row({ remaining_min: 10 })), 'nearing');
  assert.equal(mediaTimeTone(row({ enabled: false })), 'off');
  assert.equal(mediaTimeTone(row()), 'ok');
});

test('Schalter: geratelokal, Standard AN, nur die explizite 0 blendet aus', async () => {
  const mod = await import('../public/utils/media-time-dashboard.js');
  localStorage.removeItem('yuvomi-media-time-dashboard');
  assert.equal(mod.isMediaTimeDashboardEnabled(), true, 'leerer Storage ist die Vorgabe, nicht die Abwahl');
  mod.setMediaTimeDashboardEnabled(false);
  assert.equal(mod.isMediaTimeDashboardEnabled(), false);
  mod.setMediaTimeDashboardEnabled(true);
  assert.equal(mod.isMediaTimeDashboardEnabled(), true);
});
