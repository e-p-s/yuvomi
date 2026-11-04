# Medienzeit: Die 8 offenen Entscheidungen - einfach erklaert

Stand: 04.11.2026. Entscheidungsvorlage fuer Chris. Grundlage: docs/medienzeit-konzept.md
(Abschnitt 8), docs/medienzeit-android-tracker.md, docs/medienzeit-windows-agent.md.
Grundprinzip: Yuvomi zaehlt und motiviert ("Treuhänder-Modell", Anreiz statt Zwang); echte
Sperre kann nur die Heimnetz-Integration. Beispiel-Familie: Kind Leo, 30 Min/Tag erlaubt,
kauft mit 10 Punkten 15 Min dazu.

## 1. Erfassung: nur Melder (e+a), oder Heimnetz-Sperrung (c) schon in v1?

Was ist gemeint?: Zaehlt Yuvomi die Zeit nur (Android-App meldet, Web-App als Fallback) - oder
soll es gleich das Netz kappen (Pi-hole/Router schaltet Leos Wi-Fi aus)?
Beispiel: Leos 30 Min sind um 15:30 verbraucht. Nur-Melder: Yuvomi zeigt "0 Min uebrig", aber
YouTube laeuft weiter. Mit Heimnetz-Sperre: Wi-Fi am Tablet geht aus, nichts laedt mehr.
Einfach: Nur zaehlen. Schneller gebaut, kein Router-noetig, kein Bruch bei WiFi-Wechseln.
Streng: Sperre ab v1 - plus ca. 1 Woche Aufwand, IP-Zuordnung ist broechelig, Router-Abhaengigkeit.
Empfehlung: Einfach. Sperra later als optionale Integration, wenn der Kern steht.

## 2. Tauschkurs: global pro Haushalt oder pro Kind?

Was ist gemeint?: Was kosten 15 Extra-Minuten Punkte - ein Preis fuer alle Kinder, oder
individuell pro Kind?
Beispiel: Leo (8) tauscht 10 Punkte = 15 Min. Mia (14) hat groessere Aufgaben mit mehr Punkten -
fuer sie vielleicht 20 Punkte = 15 Min.
Einfach: Ein Kurs fuer alle (z.B. ueberall 10 Punkte = 15 Min).
Streng: Pro Kind einstellbar. Vorteil: passt zu Alter und Aufgabenlage; Nachteil: mehr Pflege,
die Kinder vergleichen und diskutieren den Kurs.
Empfehlung: Pro Kind (steht auch als Vorschlag im Konzept) - die Flexibilitaet ist der eigentliche
Wert des Punkte-Systems.

## 3. Duerfen Kinder selbst sperren ("selbst Schluss"), oder nur Eltern-Sperre?

Was ist gemeint?: Kann Leo selbst "Fertig fuer heute" druecken, oder bestimmen nur die Eltern?
Beispiel: Leo ist um 19:00 fertig und macht seinen Tag selbst zu; die restlichen 10 Min verfallen
oder gelten als "gespart", je nach Regel.
Einfach: Nur Eltern-Sperre. Keine vergessenen Selbst-Sperren, kein Aergernis.
Streng: Kind kann selbst zumachen - und kommt allein nicht mehr raus. Nachteil: vergessene Sperren,
Eltern muessen entsperren.
Empfehlung: Ja, aber nur in eine Richtung: Kind macht den Tag zu, Oeffnen nur durch Eltern
(oder automatischer Reset am naechsten Tag).

## 4. max_daily_minutes als harter Cap (Punkte koennen ihn nicht ueberheben) - ja/nein?

Was ist gemeint?: Der Deckel. Kann Leo sich mit Punkten freikaufen, oder ist bei 90 Min Schluss,
egal wie voll sein Punktekonto ist?
Beispiel: 30 Min/Tag, Max 90 Min. Leo hat 200 Punkte gespart. Harter Cap: bei 90 Min ist Ende.
Kaufbarer Cap: er hebt auf 120 Min an.
Einfach: Ja, hart. Die Grenze ist die Gesundheitsgrenze, Punkte hin oder her.
Streng-Alternative (Cap kaufbar): belohnt Fleiss, hoehlt aber den Sinn des Caps aus.
Empfehlung: Ja, hart. Unterhalb des Caps ist alles verhandelbar, der Cap selbst nicht.

## 5. Geschwister-Gruppenkontingent in v1 oder spaeter?

Was ist gemeint?: Eine gemeinsame Zeit-Kasse fuer Leo und Mia ("60 Min zusammen auf dem einen
Tablet"), oder hat jedes Kind seinen eigenen Plan?
Beispiel: Die beiden schauen zusammen 40 Min etwas auf dem Familien-Tablet. Wer bekommt was
abgezogen? Bei eigenen Plaenen: jeder 40 Min von seinem eigenen Tag.
Einfach: Spaeter. Jeder Kind-Plan bleibt 1:1, gemeinsame Zeit zahlt jeder aus seinem Topf.
Streng: v1 schon mit Gruppenplan - mehr Code, und die Streitfrage "wer war schuld, dass die
60 Min um sind?" lost die Software nicht.
Empfehlung: Spaeter. Das Konzept laesst es fuer v1 bewusst draussen - gut so.

## 6. APK-Meldeinterval: speichert Yuvomi Rohzeiten, nur Aggregat, oder gar nichts?

Was ist gemeint?: Die Roh-Frage hinter dem Datenschutz: kennt Yuvomi die exakten Zeiten
("15:03:11 bis 15:31:47 YouTube"), nur Bloecke ("15 Uhr: 15 Min") oder nur die Tagessumme
("Montag: 45 Min")?
Beispiel: Kind oeffnet YouTube um 15:03. Mit Rohzeiten kann man spaeter nachsehen: war das
waehrend der Lernzeit? Nur mit Tagessumme ist die Frage nicht mehr beantwortbar.
Einfach (der Vorschlag aus dem Android-Dokument): Rohzeiten - nur Paketname + Start/Ende +
Dauer, KEIN Bildschirminhalt, keine URLs. Sichtbar nur fuer Haushalts-Admin, Loeschen per
Geräterevoke, Aufbewahrung ca. 90 Tage.
Streng: Nur Tagessummen. Maximaler Datenschutz, aber Nachtraege und Streitfaelle lassen sich
nicht mehr aufklaeren, Nachmeldungen werden ungenau.
Empfehlung: Rohzeiten mit 90-Tage-Frist; spaeter optionaler Schalter "nur aggregiert" fuer
datenschutz-sensible Familien.

## 7. Upstream-PR erwuenscht oder nur Fork-Feature?

Was ist gemeint?: Geht das Feature zurueck zum Original-Projekt (yuvomi upstream), oder bleibt
es exklusiv in unserem Fork?
Beispiel: Upstream heisst: alle 27 Sprachdateien pflegen, OpenAPI-Tests erfuellen, SPEC.md
schreiben, bis der Original-Maintainer zustimmt. Fork-only heisst: wir bauen, was wir wollen.
Einfach: Fork-only. Schnell und frei; aber bei Upstream-Aenderungen muessen wir selbst
nachziehen.
Streng: Upstream-PR. Vorteil: andere Familien profitieren, Wartung teilt sich; Nachteil:
merklich mehr Arbeit und Fremdentscheidungen ueber unser Feature.
Empfehlung: Erst Fork-only und stabilisieren; Upstream-PR spaeter, wenn das Design gefroren ist.

## 8. Quiet-Hours auch als globale Haushalts-Sperre (bildschirmfreie Zeit) fuer Eltern sichtbar?

Was ist gemeint?: Ruhezeiten (z.B. Sperre ab 20:30) gibt es pro Kind. Soll es zusaetzlich eine
Zeit geben, die den ganzen Haushalt trifft - auch die Eltern - und fuer alle sichtbar ist
(z.B. Essenszeit, bildschirmfreier Abend)?
Beispiel: Familie einigt sich: 18:30-19:30 ist essenszeit ohne Bildschirme. Auf dem Dashboard
sehen alle "Ruhezeit aktiv - noch 42 Min" statt nur Leos Kinder-Sperrhinweis.
Einfach: Nein, Quiet-Hours bleiben pro Kind. Weniger Regeln, weniger UI.
Streng: Ja, globale Haushalts-Zeit. Nachteil: auch Eltern betroffen, Diskussion vorprogrammiert;
da Yuvomi ohnehin nicht hart sperrt, ist es ein Signal, kein Zwang.
Empfehlung: Ja - aber nur als sichtbares Signal fuer den Haushalt, nicht als Regelzwang. Der
Mehrwert ist das gemeinsame "alle offline", nicht die Technik.

## Ankreuzliste (pro Zeile eine Antwort eintragen)

| # | Entscheidung                                                    | Antwort (Ja/Nein/Wahl) |
|---|-----------------------------------------------------------------|----------------------|
| 1 | v1 nur Zaehlen (e+a), Heimnetz-Sperre spaeter?                  | [ ]                  |
| 2 | Tauschkurs pro Kind (statt ein Kurs fuer alle)?                 | [ ]                  |
| 3 | Kind darf selbst zumachen, Entsperren nur durch Eltern?         | [ ]                  |
| 4 | max_daily_minutes ist hart, Punkte kommen nicht drueber?        | [ ]                  |
| 5 | Geschwister-Gruppenkontingent: erst spaeter, nicht v1?          | [ ]                  |
| 6 | Rohzeiten speichern (Paket + Start/Ende, ~90 Tage)?             | [ ]                  |
| 7 | Erst Fork-only, Upstream-PR spaeter?                            | [ ]                  |
| 8 | Globale Haushalts-Ruhezeit als Sichtbarkeit fuer alle?          | [ ]                  |
