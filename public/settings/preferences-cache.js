import { api } from '/api.js';

/**
 * Geteilter Preferences-Zugriff für die Settings-Blätter.
 *
 * Neun Blätter holten `GET /preferences` jeweils selbst; fünf Blattwechsel
 * kosteten fünf identische Requests (Critique 2026-07-27). Der Cache hält den
 * laufenden Request, nicht dessen Ergebnis - parallele Aufrufer teilen sich
 * damit dieselbe Antwort, und ein Fehler verwirft ihn wieder, statt eine
 * kaputte Antwort festzuhalten.
 *
 * Gültigkeitsbereich ist ein Settings-Besuch: `resetPreferencesCache()` läuft
 * beim Mounten einer frischen Shell. Schreibende Stellen ausserhalb der
 * Settings (z. B. die Widget-Konfiguration im Dashboard) sind damit abgedeckt,
 * weil der Weg dorthin und zurück die Shell neu montiert.
 */
let pending = null;
// Der letzte ECHT gesetzte Stand (eine Antwort, die ankam, oder eine eigene
// savePreferences-Patch). `pending` kann dasselbe Feld schon enthalten, ohne
// dass die Antwort eingetroffen ist - fuer sofort festliegende Anzeigen ist das
// zu frueh (siehe cachedPreference).
let loaded = null;

export function resetPreferencesCache() {
  pending = null;
}

export function getPreferences() {
  if (!pending) {
    pending = api.get('/preferences')
      .then((response) => {
        const data = response?.data ?? {};
        loaded = data;
        return data;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}

/**
 * Der Stand EINES Schalters, ohne auf die Antwort zu warten. Fuer Anzeigen, die
 * beim Zeichnen schon festliegen muss (die Aufgaben-Leseansicht): der Wert
 * hinterlaeufiger Requests zaehlt nicht, sie koennen den Blick schon verfehlt
 * haben; er zaehlt erst, wenn er wirklich gesetzt wurde. Kein Nachziehen - ein
 * Text, der nach dem Oeffnen einspringt, verschiebt die Zeilen unter dem Blick
 * des Lesers.
 */
export function cachedPreference(key, fallback = false) {
  if (!loaded || !(key in loaded)) return fallback;
  const value = loaded[key];
  return value === undefined ? fallback : value;
}

/**
 * Schreibt Preferences und verwirft den Cache. Bewusst kein Zusammenführen der
 * Antwort: `PUT /preferences` liefert einen anderen, kleineren Ausschnitt als
 * `GET` - ihn als Cache zu setzen würde Felder verschwinden lassen.
 *
 * Die abgeschickten Felder dagegen duerfen in `loaded` nachziehen: sie sind
 * genau die Antwort, die der Nutzer gemeint hat, und eine Anzeige, die einen
 * Schalter sofort festliest (die Aufgaben-Leseansicht), soll nach einem
 * Speichern denselben Stand zeigen wie das Blatt, auf dem er ihn gesetzt hat.
 */
export async function savePreferences(patch) {
  try {
    return await api.put('/preferences', patch);
  } finally {
    pending = null;
    if (patch && typeof patch === 'object') {
      loaded = { ...(loaded ?? {}), ...patch };
    }
  }
}
