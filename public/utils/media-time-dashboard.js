// Schalter: Medienzeit-Kachel auf der Uebersicht.
// GERAETELOKAL UND MANUELL (utils/local-toggle.js, Muster wall-mode.js): eine
// Anzeigepraferenz ist eine Gewohnheit des Lesegeraets, kein Haushaltswert - der
// Server kennt keinen `media_time_dashboard`-Key und soll ihn nicht erfinden.
//
// ZWEI EBENEN, bewusst getrennt:
//   - das MODUL selbst (Medienzeit an/aus) schaltet der Haushalt: `media_time_enabled`
//     via PUT /preferences; ist es aus, faellt die Kachel ueber MODULE_FOR_WIDGET
//     ('media_time') aus Raster UND Anpassen-Ablage;
//   - dieser Schalter blendet die Kachel auf DIESEM Geraet zusaetzlich aus,
//     Standard AN (kein gespeicherter Wert = an).
import { createLocalToggle } from '/utils/local-toggle.js';

const toggle = createLocalToggle({ key: 'yuvomi-media-time-dashboard', defaultOn: true });

/** true = Kachel darf stehen (Standard); false = auf diesem Geraet ausgeblendet. */
export function isMediaTimeDashboardEnabled() {
  return toggle.isEnabled();
}

export function setMediaTimeDashboardEnabled(on) {
  toggle.setEnabled(on);
}
