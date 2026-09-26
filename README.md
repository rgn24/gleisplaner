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
5. Die **Bauanleitung** in der Seitenleiste listet Gleisbelegung je Anschluss, Signale (mit Richtung und
   Einbahn-Einstellung), Kreuzungen und Weichen. Hover hebt das Element in der Zeichnung hervor.
6. „Datei“: Beispiel laden, Plan als JSON speichern/laden, als PNG/SVG exportieren. Der aktuelle Plan wird
   automatisch im Browser gespeichert.

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

`js/planner.js` (Logik) und `js/geometry.js` sind DOM-frei und laufen auch unter Node. Deploy: Push auf `main`
(GitHub Pages).
