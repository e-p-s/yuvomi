// Schalter: Belohnungs-Reiter als Seitenleiste (Desktop) bzw. gestapelte Liste (Mobil).
// GERAETELOKAL UND MANUELL. localStorage, wie Theme, Locale und Wand-Modus
// (utils/wall-mode.js): die Ansichtspaetzung ist eine Gewohnheit des Lesegeraets,
// kein Haushaltswert - der Server kennt sie nicht und soll sie nicht kennen.
const REWARDS_TABS_SIDE_KEY = 'yuvomi-rewards-tabs-side';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* privates Fenster: Ansicht bleibt Standard */ }
}

/** true = Reiter als Seitenleiste/Gestapel; Standard ist die horizontale Bar. */
export function isRewardsTabsSideEnabled() {
  return safeGet(REWARDS_TABS_SIDE_KEY) === '1';
}

export function setRewardsTabsSideEnabled(on) {
  safeSet(REWARDS_TABS_SIDE_KEY, on ? '1' : '0');
}
