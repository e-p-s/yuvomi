// Geraetelokale Ansichtsschalter (localStorage) an einer Stelle.
// Muster: utils/wall-mode.js und utils/rewards-tabs-side.js (die beide hierher
// delegieren). Die Ansichtspaetzung ist eine Gewohnheit des Lesegeraets, kein
// Haushaltswert - der Server kennt diese Keys nicht und soll sie nicht kennen.
//
// safeGet/safeSet tolerieren das private Fenster (Storage kann dort throwen):
// ohne Speicher bleibt jede Ansicht bei ihrer Vorgabe, nichts kippt hart.

export function createLocalToggle({ key, defaultOn = false }) {
  function safeGet() {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(value) {
    try { localStorage.setItem(key, value); } catch { /* privates Fenster: Ansicht bleibt Standard */ }
  }
  return {
    key,
    /** Default-Logik pro Schalter: defaultOn=true heisst 'erst aus bei 0'. */
    isEnabled() {
      const raw = safeGet();
      if (raw === null) return defaultOn;
      return raw === '1';
    },
    setEnabled(on) {
      // Bei defaultOn fuehrt nur die explizite 0 zur Abwahl (Erststart = an).
      safeSet(on ? '1' : '0');
      void defaultOn;
    },
  };
}
