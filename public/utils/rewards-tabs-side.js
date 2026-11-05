// Schalter: Belohnungs-Reiter als Seitenleiste (Desktop) bzw. gestapelte Liste (Mobil).
// GERAETELOKAL UND MANUELL. localStorage, wie Theme, Locale und Wand-Modus
// (utils/wall-mode.js): die Ansichtspaetzung ist eine Gewohnheit des Lesegeraets,
// kein Haushaltswert - der Server kennt sie nicht und soll sie nicht kennen.
// Der Kern (safeGet/safeSet) lebt in utils/local-toggle.js.
import { createLocalToggle } from '/utils/local-toggle.js';

const toggle = createLocalToggle({ key: 'yuvomi-rewards-tabs-side', defaultOn: false });

/** true = Reiter als Seitenleiste/Gestapel; Standard ist die horizontale Bar. */
export function isRewardsTabsSideEnabled() {
  return toggle.isEnabled();
}

export function setRewardsTabsSideEnabled(on) {
  toggle.setEnabled(on);
}
