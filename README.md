# Gleisknoten-Planer für Transport Fever

Kleine Web-App zum Planen von Bahnknoten in Transport Fever 2/3. Man gibt ein, **wie viele Gleise an welcher Stelle
in den Knoten kommen** und **welche Anschlüsse miteinander verbunden sein sollen** – das Tool schlägt daraus einen
staufreien Gleisplan vor: welches Gleis wohin führt, wo Weichen und Brücken nötig sind und **wo welches Signal in
welche Richtung steht**.

**Online:** https://rgn24.github.io/gleisplaner/

## Bedienung

1. **Anschlüsse** anlegen (Doppelklick auf die Fläche oder „＋ Anschluss“), Gleisanzahl in der Seitenleiste setzen.
   1 Gleis = eingleisige Strecke.
2. **Verbinden:** Anschluss anklicken und den „+“-Griff auf einen anderen Anschluss ziehen – oder in der
   Seitenleiste die Häkchen setzen. Jede Verbindung gilt in beide Richtungen.
3. Der **Gleisplan** entsteht sofort. Die Pfeile laufen animiert in Fahrtrichtung (auf eingleisigen Stücken
   abwechselnd in beide Richtungen; ⏸ in der Werkzeugleiste hält sie an), K-Schilder markieren Kreuzungen.
4. **Brücke oder ebenerdig** – auf drei Ebenen einstellbar, das Genauere gewinnt:
   - *Einstellungen → Kreuzungen (Standard)*: gilt für alle Verbindungen.
   - *Verbindung anklicken → Kreuzungen dieser Verbindung*: „Standard“, „Brücke/Tunnel“ oder „Ebenerdig“ für
     alle Stellen, an denen diese Verbindung andere kreuzt. „Ebenerdig“ hat Vorrang vor „Brücke/Tunnel“; wer
     „Brücke/Tunnel“ gewählt hat, liegt oben.
   - *K-Schild anklicken*: eine einzelne Kreuzung umstellen (welche Verbindung oben liegt oder flach).
5. Die **Bauanleitung** beginnt mit dem **Bauablauf**: erst Zuläufe und Weichen, dann die Verbindungen, die
   unten liegen, danach die darüberliegenden (beim Überbauen entsteht die Brücke automatisch), zuletzt die
   Signale. Dazu Gleisbelegung je Anschluss, Signale (Richtung + Einbahn), Kreuzungen und Weichen. Hover über
   einen Eintrag oder Hinweis markiert die Stelle in der Zeichnung.
6. „Datei“: Beispiel laden, Plan als JSON speichern/laden, als PNG/SVG exportieren. Der aktuelle Plan wird
   automatisch im Browser gespeichert.

## Bahnhofsplaner

Zweiter Planer unter **„Bahnhof“** (https://rgn24.github.io/gleisplaner/bahnhof.html):

1. **Bahnsteiggleise** von oben nach unten anlegen und je Gleis die Zugart wählen (Personen/Güter).
   Richtung „auto“: beim Durchgangsbahnhof fährt die obere Hälfte nach links, die untere nach rechts
   (Rechtsverkehr) – so kreuzen sich Ein- und Ausfahrten im Vorfeld nicht. Einzelne Gleise lassen sich auf
   → / ← / ⇄ festlegen.
2. **Streckengleise** links und rechts: Anzahl und Zugart (P, G oder P+G). Nur eine Seite = Kopfbahnhof,
   1 Gleis = eingleisige Strecke. Rein/raus ergibt sich aus dem Rechts- bzw. Linksverkehr.
3. Der Planer ordnet jedem Bahnsteiggleis passende Streckengleise zu (obere zu oberen, damit nichts kreuzt),
   baut daraus **Weichenstraßen**, setzt bei Bedarf **gekreuzte Gleiswechsel** (Kopfbahnhof, Vorsortieren) und
   **Signale**: E vor dem Vorfeld, A am Bahnsteigende, B auf der Strecke hinter der letzten Weiche.
4. Wo sich Weichenstraßen doch kreuzen müssen (Zugarten liegen „falsch herum“), zeigt er die Flachkreuzung
   und einen Tipp, wie man die Gleise besser sortiert.

## Signalregeln

In Transport Fever 2 und 3 sind alle Signale Pfadsignale (grün, sobald der Weg des Zuges bis zum nächsten Signal
frei ist). „Einbahn: Ja“ verhindert das Passieren von hinten und erzwingt so Rechts- bzw. Linksbetrieb.

| Signal | Ort | Richtung | Einbahn |
|---|---|---|---|
| **E** Einfahrt | jedes Einfahrgleis vor der ersten Weiche; davor ≥ 1 Zuglänge Warteplatz | in den Knoten | Ja (eingleisig: Nein) |
| **A** Ausfahrt | jedes Ausfahrgleis, **≥ 1 Zuglänge hinter der letzten Weiche/Kreuzung** | aus dem Knoten | Ja |
| **Z** Warten | vor Einfädelung oder Flachkreuzung, *wenn* davor Platz für einen ganzen Zug ist | Fahrtrichtung | Ja |

## So rechnet das Tool

- Rechtsverkehr: in Blickrichtung Knoten rechts = Einfahrt, links = Ausfahrt (Linksverkehr gespiegelt).
- Abfahrende Ströme werden wie Abbiegespuren sortiert (äußeres Gleis = nächstes Ziel auf dieser Seite).
  Mehr Ströme als Gleise → Weichenstraßen, weniger → mehrere Gleise je Richtung.
- Alle Gleisenden liegen auf einem Kreis um die Knotenmitte; die Fahrwege dazwischen sind Geodäten der
  Poincaré-Kreisscheibe. Dadurch entstehen **nur die Kreuzungen, die topologisch nötig sind**, jede genau einmal.

## Entwicklung

Reines HTML/CSS/JavaScript ohne Build-Schritt – `index.html` lässt sich direkt öffnen.

```bash
python3 -m http.server 4174   # Vorschau unter http://localhost:4174
node --test                   # Tests der Planungslogik
```

`js/planner.js` (Knoten), `js/station.js` (Bahnhof) und `js/geometry.js` sind DOM-frei und laufen auch unter
Node. Bei jeder Veröffentlichung in `index.html` und `bahnhof.html` die `?v=N` der Skripte hochzählen – die Seite
erkennt neue Versionen dann selbst. Deploy: Push auf `main`
(GitHub Pages).
