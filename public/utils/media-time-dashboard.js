// Schalter: Medienzeit-Kachel auf der Uebersicht.
// GERAETELOKAL UND MANUELL. localStorage, wie Theme, Locale, Wand-Modus
// (utils/wall-mode.js) und die Belohnungs-Seitenleiste (utils/rewards-tabs-side.js):
// eine Anzeigepraferenz ist eine Gewohnheit des Lesegeraets, kein Haushaltswert -
// der Server kennt keinen `media_time_dashboard`-Praferenz-Key und soll ihn nicht
// erfinden (PUT /preferences kennt nur, was server/routes/preferences.js deklariert).
//
// ZWEI EBENEN, bewusst getrennt:
//   - das MODUL selbst (Medienzeit an/aus) schaltet der Haushalt: `media_time_enabled`
//     via PUT /preferences und der Modulschalter. Ist es aus, faellt die Kachel
//     ueber MODULE_FOR_WIDGET ('media_time') aus Raster UND Anpassen-Ablage;
//   - dieser Schalter blendet die Kachel auf DIESEM Geraet zusaetzlich aus,
//     Standard AN (kein gespeicherter Wert = an). Aus ist er erst, wenn der
//     Wert explizit '0' lautet - ein geleerter Storage (Erststart, Abmelden)
//     ist die Vorgabe, nicht die Abwahl.
const MEDIA_TIME_DASHBOARD_KEY = 'yuvomi-media-time-dashboard';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* privates Fenster: Ansicht bleibt Standard */ }
}

/** true = Kachel darf stehen (Standard); false = auf diesem Geraet ausgeblendet. */
export function isMediaTimeDashboardEnabled() {
  return safeGet(MEDIA_TIME_DASHBOARD_KEY) !== '0';
}

export function setMediaTimeDashboardEnabled(on) {
  safeSet(MEDIA_TIME_DASHBOARD_KEY, on ? '1' : '0');
}
